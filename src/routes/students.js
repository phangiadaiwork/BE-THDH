const express = require('express');
const bcrypt = require('bcrypt');
const multer = require('multer');
const xlsx = require('xlsx');
const { PrismaClient } = require('@prisma/client');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();
const upload = multer({ storage: multer.memoryStorage() });

// POST /api/students/bulk — tạo học sinh hàng loạt từ JSON
router.post('/bulk', authenticate, requireRole('TEACHER'), async (req, res) => {
  try {
    const { students } = req.body;

    if (!Array.isArray(students) || students.length === 0) {
      return res.status(400).json({ error: 'Cần cung cấp danh sách học sinh' });
    }

    const created = [];
    const errors = [];

    for (const student of students) {
      const { username, password, fullName, className, school } = student;

      if (!username || !password || !fullName) {
        errors.push({ username: username || '?', error: 'Thiếu trường bắt buộc' });
        continue;
      }

      try {
        const hashed = await bcrypt.hash(password, 10);
        const newUser = await prisma.user.create({
          data: {
            username: username.trim(),
            password: hashed,
            fullName: fullName.trim(),
            className: (className || '').trim(),
            school: (school || '').trim(),
            role: 'STUDENT',
          },
        });
        created.push({
          id: newUser.id,
          username: newUser.username,
          fullName: newUser.fullName,
          className: newUser.className,
        });
      } catch (err) {
        if (err.code === 'P2002') {
          errors.push({ username, error: 'Tên đăng nhập đã tồn tại' });
        } else {
          errors.push({ username, error: err.message });
        }
      }
    }

    res.json({ created, errors });
  } catch (error) {
    console.error('Bulk create error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/students/template — tải file Excel mẫu
router.get('/template', authenticate, requireRole('TEACHER'), (req, res) => {
  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.aoa_to_sheet([
    ['username', 'password', 'fullName', 'className', 'school'],
    ['hs001', 'matkhau123', 'Nguyễn Văn A', '10A1', 'THPT Lê Lợi'],
    ['hs002', 'matkhau456', 'Trần Thị B', '10A1', 'THPT Lê Lợi'],
    ['hs003', 'matkhau789', 'Lê Văn C', '10A2', 'THPT Lê Lợi'],
  ]);
  ws['!cols'] = [{ wch: 14 }, { wch: 14 }, { wch: 22 }, { wch: 10 }, { wch: 20 }];
  xlsx.utils.book_append_sheet(wb, ws, 'HocSinh');
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="mau_hoc_sinh.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// POST /api/students/import — import từ file Excel
router.post('/import', authenticate, requireRole('TEACHER'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Cần upload file Excel' });

    const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(ws, { defval: '' });

    if (rows.length === 0) return res.status(400).json({ error: 'File không có dữ liệu' });

    const students = rows.map((r) => ({
      username: String(r.username || '').trim(),
      password: String(r.password || '').trim(),
      fullName: String(r.fullName || '').trim(),
      className: String(r.className || '').trim(),
      school: String(r.school || '').trim(),
    }));

    const created = [];
    const errors = [];

    for (const student of students) {
      const { username, password, fullName, className, school } = student;
      if (!username || !password || !fullName) {
        errors.push({ username: username || '?', error: 'Thiếu trường bắt buộc' });
        continue;
      }
      try {
        const hashed = await bcrypt.hash(password, 10);
        const newUser = await prisma.user.create({
          data: { username, password: hashed, fullName, className, school, role: 'STUDENT' },
        });
        created.push({ id: newUser.id, username: newUser.username, fullName: newUser.fullName, className: newUser.className });
      } catch (err) {
        errors.push({ username, error: err.code === 'P2002' ? 'Tên đăng nhập đã tồn tại' : err.message });
      }
    }

    res.json({ created, errors });
  } catch (error) {
    console.error('Import students error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/students — danh sách học sinh
router.get('/', authenticate, requireRole('TEACHER'), async (req, res) => {
  try {
    const students = await prisma.user.findMany({
      where: { role: 'STUDENT' },
      select: {
        id: true,
        username: true,
        fullName: true,
        className: true,
        school: true,
        createdAt: true,
      },
      orderBy: [{ className: 'asc' }, { fullName: 'asc' }],
    });
    res.json(students);
  } catch (error) {
    console.error('Get students error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/students/:id — cập nhật thông tin học sinh
router.put('/:id', authenticate, requireRole('TEACHER'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { fullName, className, school, username } = req.body;

    const data = {};
    if (fullName !== undefined) data.fullName = fullName.trim();
    if (className !== undefined) data.className = className.trim();
    if (school !== undefined) data.school = school.trim();
    if (username !== undefined) data.username = username.trim();

    const updated = await prisma.user.update({
      where: { id },
      data,
      select: { id: true, username: true, fullName: true, className: true, school: true },
    });
    res.json(updated);
  } catch (error) {
    if (error.code === 'P2002') return res.status(400).json({ error: 'Tên đăng nhập đã tồn tại' });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/students/:id/reset-password — đặt lại mật khẩu
router.put('/:id/reset-password', authenticate, requireRole('TEACHER'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { newPassword } = req.body;

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Mật khẩu phải ít nhất 6 ký tự' });
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({ where: { id }, data: { password: hashed } });
    res.json({ message: 'Đã đặt lại mật khẩu thành công' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/students/:id
router.delete('/:id', authenticate, requireRole('TEACHER'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await prisma.user.delete({ where: { id } });
    res.json({ message: 'Đã xóa học sinh' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
