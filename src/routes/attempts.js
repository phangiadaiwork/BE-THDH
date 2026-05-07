const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// POST /api/attempts/start — bắt đầu lượt làm mới (trả về attemptId)
router.post('/start', authenticate, async (req, res) => {
  try {
    const { examId } = req.body;
    const userId = req.user.id;
    const parsedExamId = parseInt(examId);

    if (isNaN(parsedExamId)) return res.status(400).json({ error: 'examId không hợp lệ' });

    const exam = await prisma.exam.findUnique({ where: { id: parsedExamId } });
    if (!exam) return res.status(404).json({ error: 'Không tìm thấy bài tập' });

    // Xóa attempt chưa hoàn thành cũ nếu có
    await prisma.attempt.deleteMany({
      where: { userId, examId: parsedExamId, isComplete: false },
    });

    const attempt = await prisma.attempt.create({
      data: { userId, examId: parsedExamId, score: 0, isComplete: false },
    });

    res.status(201).json({ attemptId: attempt.id });
  } catch (error) {
    console.error('Start attempt error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/attempts/answer — lưu câu trả lời từng node
router.post('/answer', authenticate, async (req, res) => {
  try {
    const { attemptId, nodeId, answer, isCorrect } = req.body;
    const userId = req.user.id;

    const attempt = await prisma.attempt.findFirst({
      where: { id: parseInt(attemptId), userId, isComplete: false },
    });
    if (!attempt) return res.status(404).json({ error: 'Không tìm thấy lượt làm' });

    await prisma.nodeAnswer.upsert({
      where: { attemptId_nodeId: { attemptId: attempt.id, nodeId: parseInt(nodeId) } },
      update: { answer: String(answer), isCorrect: Boolean(isCorrect) },
      create: {
        attemptId: attempt.id,
        nodeId: parseInt(nodeId),
        answer: String(answer),
        isCorrect: Boolean(isCorrect),
      },
    });

    res.json({ ok: true });
  } catch (error) {
    console.error('Save answer error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/attempts/complete — hoàn thành lượt làm
router.post('/complete', authenticate, async (req, res) => {
  try {
    const { attemptId, score } = req.body;
    const userId = req.user.id;
    const parsedScore = parseInt(score);

    const attempt = await prisma.attempt.findFirst({
      where: { id: parseInt(attemptId), userId, isComplete: false },
    });
    if (!attempt) return res.status(404).json({ error: 'Không tìm thấy lượt làm' });

    const updated = await prisma.attempt.update({
      where: { id: attempt.id },
      data: { score: isNaN(parsedScore) ? 0 : parsedScore, isComplete: true },
    });

    const allAttempts = await prisma.attempt.findMany({
      where: { userId, examId: attempt.examId, isComplete: true },
      orderBy: { createdAt: 'asc' },
    });

    const total = allAttempts.reduce((sum, a) => sum + a.score, 0);
    const avgScore = parseFloat((total / allAttempts.length).toFixed(2));

    res.json({ attempt: updated, avgScore, attemptCount: allAttempts.length });
  } catch (error) {
    console.error('Complete attempt error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/attempts/progress?examId= — lấy tiến độ đang làm dở
router.get('/progress', authenticate, async (req, res) => {
  try {
    const { examId } = req.query;
    const userId = req.user.id;

    if (!examId) return res.status(400).json({ error: 'examId là bắt buộc' });

    const attempt = await prisma.attempt.findFirst({
      where: { userId, examId: parseInt(examId), isComplete: false },
      include: {
        nodeAnswers: { select: { nodeId: true, answer: true, isCorrect: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!attempt) return res.json(null);

    res.json({
      attemptId: attempt.id,
      nodeAnswers: attempt.nodeAnswers,
    });
  } catch (error) {
    console.error('Get progress error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/attempts/submit — nộp bài (backward compat)
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

    const exam = await prisma.exam.findUnique({ where: { id: parsedExamId } });
    if (!exam) return res.status(404).json({ error: 'Không tìm thấy bài tập' });

    const attempt = await prisma.attempt.create({
      data: { userId, examId: parsedExamId, score: parsedScore, isComplete: true },
    });

    const allAttempts = await prisma.attempt.findMany({
      where: { userId, examId: parsedExamId, isComplete: true },
      orderBy: { createdAt: 'asc' },
    });

    const total = allAttempts.reduce((sum, a) => sum + a.score, 0);
    const avgScore = parseFloat((total / allAttempts.length).toFixed(2));

    res.status(201).json({ attempt, avgScore, attemptCount: allAttempts.length });
  } catch (error) {
    console.error('Submit attempt error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/attempts/my?examId= — lịch sử làm bài của học sinh
router.get('/my', authenticate, async (req, res) => {
  try {
    const { examId } = req.query;
    const userId = req.user.id;

    const where = { userId, isComplete: true };
    if (examId) where.examId = parseInt(examId);

    const attempts = await prisma.attempt.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { exam: { select: { title: true } } },
    });

    // Kiểm tra có bài đang làm dở không
    const inProgressQuery = { userId, isComplete: false };
    if (examId) inProgressQuery.examId = parseInt(examId);
    const inProgressAttempts = await prisma.attempt.findMany({
      where: inProgressQuery,
      select: { examId: true },
    });
    const inProgressExamIds = new Set(inProgressAttempts.map((a) => a.examId));

    const examIds = [...new Set(attempts.map((a) => a.examId))];
    const avgByExam = {};
    for (const eid of examIds) {
      const ea = attempts.filter((a) => a.examId === eid);
      const total = ea.reduce((s, a) => s + a.score, 0);
      avgByExam[eid] = parseFloat((total / ea.length).toFixed(2));
    }

    res.json({ attempts, avgByExam, inProgressExamIds: [...inProgressExamIds] });
  } catch (error) {
    console.error('Get my attempts error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/attempts/stats?className= — thống kê theo lớp (giáo viên)
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
      where: { userId: { in: studentIds }, isComplete: true },
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

// GET /api/attempts/node-stats?examId=&className= — thống kê từng node (giáo viên)
router.get('/node-stats', authenticate, requireRole('TEACHER'), async (req, res) => {
  try {
    const { examId, className } = req.query;
    if (!examId) return res.status(400).json({ error: 'examId là bắt buộc' });

    const parsedExamId = parseInt(examId);
    const exam = await prisma.exam.findUnique({
      where: { id: parsedExamId },
      include: { nodes: { orderBy: [{ parentId: 'asc' }, { order: 'asc' }] } },
    });
    if (!exam) return res.status(404).json({ error: 'Không tìm thấy bài tập' });

    // Lấy danh sách student phù hợp
    const studentWhere = { role: 'STUDENT' };
    if (className) studentWhere.className = className;
    const students = await prisma.user.findMany({
      where: studentWhere,
      select: { id: true },
    });
    const studentIds = students.map((s) => s.id);

    // Lấy tất cả attempt hoàn thành của bài này
    const attempts = await prisma.attempt.findMany({
      where: { examId: parsedExamId, userId: { in: studentIds }, isComplete: true },
      select: { id: true },
    });
    const attemptIds = attempts.map((a) => a.id);

    // Lấy tất cả nodeAnswer
    const nodeAnswers = await prisma.nodeAnswer.findMany({
      where: { attemptId: { in: attemptIds } },
      select: { nodeId: true, isCorrect: true },
    });

    // Tổng hợp theo node
    const nodeStats = exam.nodes.map((node) => {
      const answers = nodeAnswers.filter((na) => na.nodeId === node.id);
      const total = answers.length;
      const correct = answers.filter((a) => a.isCorrect).length;
      const incorrect = total - correct;
      return {
        nodeId: node.id,
        label: node.label,
        parentId: node.parentId,
        total,
        correct,
        incorrect,
        errorRate: total > 0 ? parseFloat(((incorrect / total) * 100).toFixed(1)) : null,
      };
    });

    // Thống kê tổng hợp theo lớp
    const classRows = await prisma.user.findMany({
      where: { role: 'STUDENT' },
      select: { className: true },
      distinct: ['className'],
      orderBy: { className: 'asc' },
    });
    const classes = classRows.map((c) => c.className).filter(Boolean);

    // Avg score theo lớp
    const classStats = await Promise.all(
      classes.map(async (cls) => {
        const clsStudents = await prisma.user.findMany({
          where: { role: 'STUDENT', className: cls },
          select: { id: true },
        });
        const clsIds = clsStudents.map((s) => s.id);
        const clsAttempts = await prisma.attempt.findMany({
          where: { examId: parsedExamId, userId: { in: clsIds }, isComplete: true },
          select: { score: true, userId: true },
        });
        const avgScore =
          clsAttempts.length > 0
            ? parseFloat((clsAttempts.reduce((s, a) => s + a.score, 0) / clsAttempts.length).toFixed(2))
            : null;
        return { className: cls, attemptCount: clsAttempts.length, avgScore };
      })
    );

    res.json({ exam: { id: exam.id, title: exam.title }, nodeStats, classStats, classes });
  } catch (error) {
    console.error('Node stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
