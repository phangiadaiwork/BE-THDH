const express = require('express');
const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// POST /api/students/bulk — tạo học sinh hàng loạt
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
      orderBy: { className: 'asc' },
    });
    res.json(students);
  } catch (error) {
    console.error('Get students error:', error);
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
