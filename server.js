const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 1. ตั้งค่าฐานข้อมูล MySQL
// ==========================================
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '123456', 
    database: process.env.DB_NAME || 'test',
    port: process.env.DB_PORT || 4000,
    // 🌟 เปิดใช้งาน SSL เฉพาะเมื่อต่อกับ Cloud (บน Render)
    ssl: process.env.DB_HOST ? { rejectUnauthorized: false } : false
};

// ==========================================
// 2. ระบบรหัสผ่าน และจัดการเซสชัน (กันเข้าซ้อน)
// ==========================================
const USERS = {
    'admin': 'admin2026',
    'judge1': '1111',
    'judge2': '2222',
    'judge3': '3333',
    'judge4': '4444',
    'judge5': '5555'
};

// เก็บข้อมูลผู้ที่กำลังใช้งานอยู่ { role: { token, lastSeen } }
const activeSessions = {}; 

// เคลียร์คนที่ปิดเว็บไปแล้วแต่ไม่ได้กดออกระบบ (เช็คทุก 10 วิ)
setInterval(() => {
    const now = Date.now();
    for (const role in activeSessions) {
        // ถ้าไม่มีการส่งสัญญาณมาเกิน 15 วินาที ถือว่าหลุด
        if (now - activeSessions[role].lastSeen > 15000) {
            delete activeSessions[role];
        }
    }
}, 10000);

// API: ล็อกอิน
app.post('/api/login', (req, res) => {
    const { role, password } = req.body;
    
    if (!USERS[role] || USERS[role] !== password) {
        return res.json({ success: false, message: 'รหัสผ่านไม่ถูกต้อง' });
    }

    // ตรวจสอบว่ามีคนใช้งานอยู่หรือไม่
    if (activeSessions[role] && (Date.now() - activeSessions[role].lastSeen < 15000)) {
        return res.json({ success: false, message: 'บัญชีนี้กำลังถูกใช้งานอยู่ในเครื่องอื่น!' });
    }

    // สร้าง Token ให้เครื่องนี้
    const token = Math.random().toString(36).substring(2, 15);
    activeSessions[role] = { token, lastSeen: Date.now() };
    res.json({ success: true, token, role });
});

// API: ส่งสัญญาณว่ายังออนไลน์อยู่ (Heartbeat)
app.post('/api/ping', (req, res) => {
    const { role, token } = req.body;
    if (activeSessions[role] && activeSessions[role].token === token) {
        activeSessions[role].lastSeen = Date.now();
        return res.json({ success: true });
    }
    // ถ้า Token ไม่ตรง แปลว่าโดนเตะ หรือเซสชันหมดอายุ
    res.json({ success: false, message: 'เซสชันหมดอายุ หรือมีคนล็อกอินซ้อน' });
});

// API: ออกจากระบบ
app.post('/api/logout', (req, res) => {
    const { role, token } = req.body;
    if (activeSessions[role] && activeSessions[role].token === token) {
        delete activeSessions[role];
    }
    res.json({ success: true });
});

// ==========================================
// 3. ระบบจัดการคะแนน (เกณฑ์ใหม่ 5 หัวข้อ)
// ==========================================
app.get('/api/scores', async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const [rows] = await connection.execute('SELECT * FROM scores');
        await connection.end();
        res.json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Database connection failed' });
    }
});

app.post('/api/scores', async (req, res) => {
    const { judge_id, contestant_id, scores } = req.body;
    try {
        const connection = await mysql.createConnection(dbConfig);
        const query = `
            INSERT INTO scores (judge_id, contestant_id, score_intro, score_theme, score_speech, score_formal, score_qa) 
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE 
                score_intro = VALUES(score_intro),
                score_theme = VALUES(score_theme),
                score_speech = VALUES(score_speech),
                score_formal = VALUES(score_formal),
                score_qa = VALUES(score_qa)
        `;
        await connection.execute(query, [
            judge_id, contestant_id, 
            scores.intro, scores.theme, scores.speech, scores.formal, scores.qa
        ]);
        await connection.end();
        res.json({ success: true, message: 'บันทึกคะแนนสำเร็จ' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 'Failed to save score' });
    }
});

app.listen(port, () => {
    console.log(`=================================`);
    console.log(`🚀 Server RMUTK FRESHY 2026 is running!`);
    console.log(`=================================`);
});