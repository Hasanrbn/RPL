/**
 * SISTEM MANAJEMEN INVENTARIS BATERAI
 * Deskripsi: Aplikasi untuk mengelola stok, penjualan, dan modul produksi internal.
 */

const express = require('express');
const mysql = require('mysql2');
const app = express();
const port = 3000;

// ==========================================
// 1. KONFIGURASI & MIDDLEWARE
// ==========================================
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true })); // Membaca data dari form HTML
app.use(express.static('public')); // Jika ada file CSS/Gambar (opsional)

// Konfigurasi Koneksi Database
const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'db_baterai'
});

db.connect((err) => {
    if (err) {
        console.error('Gagal koneksi ke database:', err.message);
        return;
    }
    console.log('Koneksi ke Database Berhasil!');
});

// ==========================================
// 2. ROUTES HALAMAN UTAMA (DASHBOARD)
// ==========================================
app.get('/', (req, res) => {
    // Definisi semua query yang dibutuhkan
    const sqlMaster = "SELECT * FROM master_barang ORDER BY nama_barang ASC";
    const sqlStok = "SELECT *, DATE_FORMAT(waktu_input, '%M %Y') as bulan_tahun FROM stok_barang ORDER BY waktu_input DESC";
    const sqlSummary = `
        SELECT 
            SUM(stok * (modal / NULLIF(stok_awal, 0))) as total_aset, 
            SUM(jumlah_terjual * (harga_jual - (modal / NULLIF(stok_awal, 0)))) as profit_nyata 
        FROM stok_barang`;
    const sqlTopSelling = `
        SELECT nama_barang, SUM(jumlah_terjual) as total_laku 
        FROM stok_barang 
        GROUP BY nama_barang 
        HAVING total_laku > 0 
        ORDER BY total_laku DESC 
        LIMIT 5`;

    // Nesting Query untuk mengumpulkan semua data sebelum render
    db.query(sqlMaster, (err, master) => {
        if (err) throw err;
        db.query(sqlStok, (err, stok) => {
            if (err) throw err;
            db.query(sqlSummary, (err, summary) => {
                if (err) throw err;
                db.query(sqlTopSelling, (err, topSelling) => {
                    if (err) throw err;

                    // Logika Pengelompokan Data per Bulan
                    const dataPerBulan = {};
                    stok.forEach(item => {
                        const bulan = item.bulan_tahun;
                        if (!dataPerBulan[bulan]) {
                            dataPerBulan[bulan] = [];
                        }
                        dataPerBulan[bulan].push(item);
                    });

                    // Kirim semua data ke EJS
                    res.render('index', { 
                        data_master: master, 
                        data_per_bulan: dataPerBulan, 
                        summary: summary[0], 
                        top_selling: topSelling 
                    });
                });
            });
        });
    });
});

// ==========================================
// 3. LOGIKA INPUT DATA (STOK & MASTER)
// ==========================================

// Menambah jenis barang baru ke daftar pilihan
app.post('/tambah-master', (req, res) => {
    const { nama_barang, kode_sku } = req.body;
    const sql = "INSERT INTO master_barang (nama_barang, kode_sku) VALUES (?, ?)";
    
    db.query(sql, [nama_barang, kode_sku], (err, result) => {
        if (err) {
            console.error(err);
            return res.send(`
                <script>
                    alert("Gagal! Kombinasi Nama Barang dan SKU ini sudah terdaftar.");
                    window.location.href = "/";
                </script>
            `);
        }
        res.redirect('/');
    });
});

// Memasukkan stok barang ke gudang
app.post('/simpan', (req, res) => {
    const { nama_barang, kode_sku, kondisi, stok, harga_jual, modal } = req.body;
    const stok_awal = stok; 
    
    const sql = `INSERT INTO stok_barang 
                 (nama_barang, kode_sku, kondisi, stok_awal, stok, harga_jual, modal) 
                 VALUES (?, ?, ?, ?, ?, ?, ?)`;
    
    db.query(sql, [nama_barang, kode_sku, kondisi, stok_awal, stok, harga_jual, modal], (err, result) => {
        if (err) throw err;
        res.redirect('/');
    });
});

// ==========================================
// 4. LOGIKA TRANSAKSI (JUAL & HISTORY)
// ==========================================

// Proses Penjualan Barang
app.post('/jual/:id', (req, res) => {
    const id = req.params.id;
    const jumlah_jual = parseInt(req.body.jumlah_jual);

    // 1. Ambil data barang (nama & harga) sebelum transaksi
    db.query("SELECT nama_barang, harga_jual FROM stok_barang WHERE id = ?", [id], (err, rows) => {
        if (err || rows.length === 0) return res.redirect('/');
        
        const namaBarang = rows[0].nama_barang;
        const hargaLog = rows[0].harga_jual; // Ambil harga untuk dicatat

        // 2. Update stok dan jumlah terjual
        const sqlUpdate = `UPDATE stok_barang SET stok = stok - ?, jumlah_terjual = jumlah_terjual + ? 
                           WHERE id = ? AND stok >= ?`;
        
        db.query(sqlUpdate, [jumlah_jual, jumlah_jual, id, jumlah_jual], (err, result) => {
            if (err) throw err;

            // Jika stok tidak cukup (affectedRows = 0), jangan catat history
            if (result.affectedRows === 0) return res.redirect('/');

            // 3. Simpan ke History (HANYA SATU KALI DI SINI)
            const logSql = `INSERT INTO history_log 
                            (barang_id, nama_barang_saat_itu, aktivitas, jumlah_perubahan, penanggung_jawab, harga_satuan_log) 
                            VALUES (?, ?, 'Penjualan', ?, NULL, ?)`;
            
            db.query(logSql, [id, namaBarang, jumlah_jual, hargaLog], (err) => {
                if (err) throw err;
                // Selesai, baru redirect
                res.redirect('/');
            });
        });
    });
});

// Menampilkan Halaman Riwayat Penjualan
app.get('/history', (req, res) => {
    // Tambahkan h.harga_satuan_log ke dalam list SELECT
    const sql = `
        SELECT 
            h.id, 
            h.aktivitas, 
            h.jumlah_perubahan, 
            h.penanggung_jawab, 
            h.harga_satuan_log, 
            h.nama_barang_saat_itu,
            DATE_FORMAT(h.waktu_log, '%d %M %Y, %H:%i') as waktu_format 
        FROM history_log h
        ORDER BY h.id DESC`;
    
    db.query(sql, (err, rows) => {
        if (err) throw err;
        res.render('history', { history: rows });
    });
});

// ==========================================
// 5. MODUL PRODUKSI INTERNAL
// ==========================================

// Tampilkan halaman daftar pengambilan produksi
// Menampilkan halaman produksi dengan data histori dan daftar barang untuk dropdown
app.get('/produksi', (req, res) => {
    const sqlHistory = "SELECT *, DATE_FORMAT(waktu_ambil, '%d %M %Y, %H:%i') as waktu_format FROM produksi_detail ORDER BY id DESC";
    
    // TAMBAHKAN kolom 'modal' di sini
    const sqlBarang = "SELECT id, nama_barang, stok, modal, harga_jual FROM stok_barang WHERE stok > 0";

    db.query(sqlHistory, (err, history) => {
        if (err) throw err;
        
        db.query(sqlBarang, (err, barang) => {
            if (err) throw err;
            
            res.render('produksi', { 
                data_produksi: history, 
                daftar_barang: barang 
            });
        });
    });
});

// Proses pengambilan barang untuk kebutuhan produksi internal
app.post('/produksi/ambil', (req, res) => {
    const { barang_id, jumlah, nama_proyek, petugas } = req.body;

    // 1. Ambil nama barangnya dulu
    db.query("SELECT nama_barang FROM stok_barang WHERE id = ?", [barang_id], (err, result) => {
        if (err) throw err;
        const namaBarang = result[0].nama_barang;

        // 2. Kurangi stok di gudang utama
        const sqlUpdateStok = "UPDATE stok_barang SET stok = stok - ? WHERE id = ? AND stok >= ?";
        db.query(sqlUpdateStok, [jumlah, barang_id, jumlah], (err, update) => {
            if (err) throw err;

            // 3. Catat rinciannya ke tabel produksi_detail
            const sqlInsertProduksi = `INSERT INTO produksi_detail 
                (nama_proyek, barang_id, nama_barang_saat_itu, jumlah_diambil, petugas_produksi) 
                VALUES (?, ?, ?, ?, ?)`;
            
            db.query(sqlInsertProduksi, [nama_proyek, barang_id, namaBarang, jumlah, petugas], (err, final) => {
                if (err) throw err;
                
                // 4. Catat juga di history_log agar riwayat keluar-masuk barang sinkron
                const sqlLog = "INSERT INTO history_log (barang_id, nama_barang_saat_itu, aktivitas, jumlah_perubahan) VALUES (?, ?, 'Produksi', ?)";
                db.query(sqlLog, [barang_id, namaBarang, jumlah]);

                res.redirect('/produksi');
            });
        });
    });
});

app.post('/produksi/proses-total', async (req, res) => {
    const { 
        nama_proyek, petugas, produk_nama, produk_sku, 
        produk_jumlah, produk_harga, komponen_id, 
        komponen_jumlah, komponen_harga_satuan 
    } = req.body;

    let totalModalDihitung = 0;

    // Pastikan data dikonversi ke Array agar tidak error saat looping
    const ids = Array.isArray(komponen_id) ? komponen_id : (komponen_id ? [komponen_id] : []);
    const jmls = Array.isArray(komponen_jumlah) ? komponen_jumlah : (komponen_jumlah ? [komponen_jumlah] : []);
    const hargas = Array.isArray(komponen_harga_satuan) ? komponen_harga_satuan : (komponen_harga_satuan ? [komponen_harga_satuan] : []);

    try {
        const komponenPromises = ids.map((id, index) => {
            return new Promise((resolve, reject) => {
                // Lewati jika ID komponen kosong (biasanya baris terakhir hasil clone yang ga diisi)
                if (!id) return resolve();

                db.query("SELECT nama_barang FROM stok_barang WHERE id = ?", [id], (err, rows) => {
                    if (err) return reject(err);
                    if (rows.length === 0) return resolve();

                    const qty = parseInt(jmls[index]) || 0;
                    const hargaSatuan = parseFloat(hargas[index]) || 0; 
                    
                    // Validasi: Jangan proses kalau qty 0 atau negatif
                    if (qty <= 0) return resolve();

                    totalModalDihitung += (hargaSatuan * qty);
                    
                    // 1. Update stok komponen
                    db.query("UPDATE stok_barang SET stok = stok - ? WHERE id = ?", [qty, id]);
                    
                    // 2. Simpan ke history_log (Menggunakan kolom harga_satuan_log)
                    const sqlLogKeluar = `
                        INSERT INTO history_log 
                        (barang_id, nama_barang_saat_itu, aktivitas, jumlah_perubahan, penanggung_jawab, harga_satuan_log) 
                        VALUES (?, ?, 'Produksi-Keluar (Rakit)', ?, ?, ?)`;
                    
                    db.query(sqlLogKeluar, [id, rows[0].nama_barang, -qty, petugas, hargaSatuan], (err) => {
                        if (err) return reject(err);
                        resolve();
                    });
                });
            });
        });

        await Promise.all(komponenPromises);

        // Hitung modal per unit produk jadi
        const modalKeseluruhan = totalModalDihitung ;

        // 3. Masukkan Produk Jadi ke stok_barang
        const sqlProduk = `
            INSERT INTO stok_barang 
            (nama_barang, kode_sku, kondisi, stok_awal, stok, harga_jual, modal) 
            VALUES (?, ?, 'BAGUS', ?, ?, ?, ?)`;
            
        // Kirim modalKeseluruhan (misal: 90000) ke kolom modal
        db.query(sqlProduk, [produk_nama, produk_sku, produk_jumlah, produk_jumlah, produk_harga, modalKeseluruhan], (err, result) => {
            if (err) throw err;
            const newProdukId = result.insertId;

            // 4. Catat riwayat masuk untuk produk jadi
            const sqlLogMasuk = `
                INSERT INTO history_log 
                (barang_id, nama_barang_saat_itu, aktivitas, jumlah_perubahan, penanggung_jawab, harga_satuan_log) 
                VALUES (?, ?, 'Produksi-Masuk (Rakit)', ?, ?, ?)`;

            db.query(sqlLogMasuk, [newProdukId, produk_nama, produk_jumlah, petugas, produk_harga || 0], (err) => {
                if (err) throw err;
                res.redirect('/history');
            });
        });

    } catch (error) {
        console.error("Detail Error:", error);
        res.status(500).send("Gagal memproses produksi: " + error.message);
    }
});

// produksi selesai
// Route untuk menerima setoran barang jadi dari tim produksi
app.post('/produksi/selesai', (req, res) => {
    const { nama_barang, kode_sku, jumlah, modal_produksi, harga_jual } = req.body;
    const stok_awal = jumlah;

    // 1. Masukkan ke stok_barang sebagai produk siap jual
    const sqlInsert = `INSERT INTO stok_barang 
        (nama_barang, kode_sku, kondisi, stok_awal, stok, harga_jual, modal) 
        VALUES (?, ?, 'BAGUS', ?, ?, ?, ?)`;

    db.query(sqlInsert, [nama_barang, kode_sku, stok_awal, jumlah, harga_jual, modal_produksi], (err, result) => {
        if (err) throw err;

        // 2. Catat ke history_log bahwa ini barang masuk dari hasil Produksi
        const logSql = "INSERT INTO history_log (barang_id, nama_barang_saat_itu, aktivitas, jumlah_perubahan) VALUES (?, ?, 'Masuk-Produksi', ?)";
        db.query(logSql, [result.insertId, nama_barang, jumlah]);

        res.redirect('/');
    });
});

// ==========================================
// 6. FITUR UTILITY (HAPUS DATA)
// ==========================================
app.get('/hapus/:id', (req, res) => {
    const id = req.params.id;
    const sql = "DELETE FROM stok_barang WHERE id = ?";
    
    db.query(sql, [id], (err, result) => {
        if (err) throw err;
        res.redirect('/');
    });
});

// Jalankan Server
app.listen(port, () => {
    console.log(`Server berjalan di http://localhost:${port}`);
});