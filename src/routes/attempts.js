const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// POST /api/attempts/submit — nộp bài, tính điểm trung bình lũy kế
router.post('/submit', authenticate, async (req, res) => {
  try {
    const { examId, score } = req.body;
    const userId = req.user.id;

    if (examId === undefined || score === undefined) {
      return res.status(400).json({ error: 'examId và score là bắt buộc' });
    }

    const parsedExamId = parseInt(examId);
    const parsedScore = parseInt(score);

    if (isNaN(parsedExamId) || isNaN(parsedScore)) {
      return res.status(400).json({ error: 'examId và score phải là số' });
    }

    // Kiểm tra bài tập tồn tại
    const exam = await prisma.exam.findUnique({ where: { id: parsedExamId } });
    if (!exam) return res.status(404).json({ error: 'Không tìm thấy bài tập' });

    // Tạo attempt mới
    const attempt = await prisma.attempt.create({
      data: { userId, examId: parsedExamId, score: parsedScore },
    });

    // Tính điểm trung bình tất cả các lần
    const allAttempts = await prisma.attempt.findMany({
      where: { userId, examId: parsedExamId },
      orderBy: { createdAt: 'asc' },
    });

    const total = allAttempts.reduce((sum, a) => sum + a.score, 0);
    const avgScore = parseFloat((total / allAttempts.length).toFixed(2));
    const attemptCount = allAttempts.length;

    res.status(201).json({ attempt, avgScore, attemptCount });
  } catch (error) {
    console.error('Submit attempt error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/attempts/my?examId=... — lịch sử làm bài của học sinh
router.get('/my', authenticate, async (req, res) => {
  try {
    const { examId } = req.query;
    const userId = req.user.id;

    const where = { userId };
    if (examId) where.examId = parseInt(examId);

    const attempts = await prisma.attempt.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { exam: { select: { title: true } } },
    });

    // Tính avgScore cho từng bài
    const examIds = [...new Set(attempts.map((a) => a.examId))];
    const avgByExam = {};
    for (const eid of examIds) {
      const examAttempts = attempts.filter((a) => a.examId === eid);
      const total = examAttempts.reduce((s, a) => s + a.score, 0);
      avgByExam[eid] = parseFloat((total / examAttempts.length).toFixed(2));
    }

    res.json({ attempts, avgByExam });
  } catch (error) {
    console.error('Get my attempts error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/attempts/stats?className=... — thống kê theo lớp (giáo viên)
router.get('/stats', authenticate, requireRole('TEACHER'), async (req, res) => {
  try {
    const { className } = req.query;

    const studentWhere = { role: 'STUDENT' };
    if (className) studentWhere.className = className;

    const students = await prisma.user.findMany({
      where: studentWhere,
      select: { id: true, username: true, fullName: true, className: true },
      orderBy: [{ className: 'asc' }, { fullName: 'asc' }],
    });

    const exams = await prisma.exam.findMany({
      select: { id: true, title: true },
      orderBy: { createdAt: 'asc' },
    });

    const studentIds = students.map((s) => s.id);
    const allAttempts = await prisma.attempt.findMany({
      where: { userId: { in: studentIds } },
      orderBy: { createdAt: 'asc' },
    });

    const stats = students.map((student) => {
      const examStats = exams.map((exam) => {
        const ea = allAttempts.filter(
          (a) => a.userId === student.id && a.examId === exam.id
        );
        const count = ea.length;
        const avgScore =
          count > 0
            ? parseFloat((ea.reduce((s, a) => s + a.score, 0) / count).toFixed(2))
            : null;
        return { examId: exam.id, examTitle: exam.title, attemptCount: count, avgScore };
      });

      return {
        studentId: student.id,
        username: student.username,
        fullName: student.fullName,
        className: student.className,
        examStats,
      };
    });

    // Danh sách lớp duy nhất
    const classRows = await prisma.user.findMany({
      where: { role: 'STUDENT' },
      select: { className: true },
      distinct: ['className'],
      orderBy: { className: 'asc' },
    });
    const classes = classRows.map((c) => c.className).filter(Boolean);

    res.json({ stats, classes, exams });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
