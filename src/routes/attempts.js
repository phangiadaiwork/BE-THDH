const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate, requireRole } = require('../middleware/auth');
const { serializeLessonExam } = require('../utils/education');

const router = express.Router();
const prisma = new PrismaClient();

async function getStudentClassId(userId) {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: { classId: true },
  });
  return user?.classId ?? null;
}

async function findAccessibleExam(examId, userId, role) {
  const where = { id: examId, deletedAt: null };

  if (role === 'STUDENT') {
    const classId = await getStudentClassId(userId);
    where.OR = [
      { isPublic: true },
      ...(classId ? [{ assignments: { some: { classId } } }] : []),
    ];
  }

  return prisma.exam.findFirst({
    where,
    include: {
      lesson: { include: { chapter: { include: { grade: true } } } },
      assignments: {
        include: {
          studentClass: {
            include: {
              school: true,
              grade: true,
              academicYear: true,
            },
          },
        },
      },
      _count: { select: { nodes: true } },
    },
  });
}

function buildAttemptSummary(attempts) {
  if (attempts.length === 0) {
    return {
      attemptCount: 0,
      avgScore: null,
      bestScore: null,
      lastScore: null,
      lastCompletedAt: null,
    };
  }

  const total = attempts.reduce((sum, attempt) => sum + attempt.score, 0);
  const bestScore = Math.max(...attempts.map((attempt) => attempt.score));
  const lastAttempt = attempts[attempts.length - 1];

  return {
    attemptCount: attempts.length,
    avgScore: parseFloat((total / attempts.length).toFixed(2)),
    bestScore,
    lastScore: lastAttempt.score,
    lastCompletedAt: lastAttempt.createdAt,
  };
}

router.post('/start', authenticate, async (req, res) => {
  try {
    const parsedExamId = parseInt(req.body.examId, 10);
    const userId = req.user.id;

    if (Number.isNaN(parsedExamId)) {
      return res.status(400).json({ error: 'examId không hợp lệ' });
    }

    const exam = await findAccessibleExam(parsedExamId, userId, req.user.role);
    if (!exam) return res.status(404).json({ error: 'Không tìm thấy bài tập' });

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

router.post('/answer', authenticate, async (req, res) => {
  try {
    const { attemptId, nodeId, answer } = req.body;
    const userId = req.user.id;

    const attempt = await prisma.attempt.findFirst({
      where: { id: parseInt(attemptId, 10), userId, isComplete: false },
    });
    if (!attempt) return res.status(404).json({ error: 'Không tìm thấy lượt làm' });

    const existingAnswer = await prisma.nodeAnswer.findUnique({
      where: { attemptId_nodeId: { attemptId: attempt.id, nodeId: parseInt(nodeId, 10) } },
    });
    if (existingAnswer) {
      return res.status(400).json({ error: 'Đã trả lời câu hỏi này' });
    }

    const node = await prisma.mindNode.findUnique({
      where: { id: parseInt(nodeId, 10) },
    });
    if (!node) return res.status(404).json({ error: 'Không tìm thấy câu hỏi' });

    const isCorrect = String(answer).trim().toUpperCase() === String(node.correctAnswer).trim().toUpperCase();

    const createdAnswer = await prisma.nodeAnswer.create({
      data: {
        attemptId: attempt.id,
        nodeId: parseInt(nodeId, 10),
        answer: String(answer).trim(),
        isCorrect: isCorrect,
      },
    });

    res.json({ ok: true, isCorrect });
  } catch (error) {
    console.error('Save answer error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/complete', authenticate, async (req, res) => {
  try {
    const { attemptId } = req.body;
    const userId = req.user.id;

    const attempt = await prisma.attempt.findFirst({
      where: { id: parseInt(attemptId, 10), userId, isComplete: false },
    });
    if (!attempt) return res.status(404).json({ error: 'Không tìm thấy lượt làm' });

    const correctAnswers = await prisma.nodeAnswer.findMany({
      where: { attemptId: attempt.id, isCorrect: true },
      include: { node: { select: { points: true } } },
    });
    
    const calculatedScore = correctAnswers.reduce((sum, na) => sum + na.node.points, 0);

    const updated = await prisma.attempt.update({
      where: { id: attempt.id },
      data: { score: calculatedScore, isComplete: true },
    });

    const allAttempts = await prisma.attempt.findMany({
      where: { userId, examId: attempt.examId, isComplete: true },
      orderBy: { createdAt: 'asc' },
    });

    const summary = buildAttemptSummary(allAttempts);

    res.json({ attempt: updated, avgScore: summary.avgScore, attemptCount: summary.attemptCount });
  } catch (error) {
    console.error('Complete attempt error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/progress', authenticate, async (req, res) => {
  try {
    const examId = parseInt(req.query.examId, 10);
    const userId = req.user.id;

    if (Number.isNaN(examId)) return res.status(400).json({ error: 'examId là bắt buộc' });

    const attempt = await prisma.attempt.findFirst({
      where: { userId, examId, isComplete: false },
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

router.get('/review', authenticate, async (req, res) => {
  try {
    const examId = parseInt(req.query.examId, 10);
    if (Number.isNaN(examId)) return res.status(400).json({ error: 'examId là bắt buộc' });

    const attempt = await prisma.attempt.findFirst({
      where: { userId: req.user.id, examId, isComplete: true },
      include: {
        nodeAnswers: {
          select: { nodeId: true, answer: true, isCorrect: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!attempt) return res.status(404).json({ error: 'Chưa có bài làm hoàn thành để xem lại' });

    res.json({
      attemptId: attempt.id,
      score: attempt.score,
      nodeAnswers: attempt.nodeAnswers,
      createdAt: attempt.createdAt,
    });
  } catch (error) {
    console.error('Review attempt error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});



router.get('/my', authenticate, async (req, res) => {
  try {
    const examId = req.query.examId ? parseInt(req.query.examId, 10) : null;
    const userId = req.user.id;

    const where = { userId };
    if (examId) where.examId = examId;

    const attempts = await prisma.attempt.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      include: {
        exam: {
          include: {
            lesson: { include: { chapter: { include: { grade: true } } } },
            assignments: {
              include: {
                studentClass: {
                  include: { school: true, grade: true, academicYear: true },
                },
              },
            },
            _count: { select: { nodes: true } },
          },
        },
      },
    });

    const grouped = {};
    attempts.forEach((attempt) => {
      if (!grouped[attempt.examId]) {
        grouped[attempt.examId] = {
          exam: serializeLessonExam(attempt.exam),
          completed: [],
          inProgress: [],
        };
      }

      if (attempt.isComplete) grouped[attempt.examId].completed.push(attempt);
      else grouped[attempt.examId].inProgress.push(attempt);
    });

    const lessons = Object.values(grouped).map((item) => {
      const summary = buildAttemptSummary(item.completed);
      return {
        ...item.exam,
        attemptSummary: {
          ...summary,
          status: item.inProgress.length > 0
            ? 'IN_PROGRESS'
            : item.completed.length > 0
              ? 'COMPLETED'
              : 'NOT_STARTED',
          canReview: item.inProgress.length === 0 && item.completed.length > 0,
        },
      };
    });

    res.json({ lessons });
  } catch (error) {
    console.error('Get my attempts error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/filters', authenticate, requireRole('TEACHER'), async (_req, res) => {
  try {
    const classes = await prisma.studentClass.findMany({
      include: {
        grade: true,
        school: true,
        academicYear: true,
      },
      orderBy: [{ academicYear: { startYear: 'desc' } }, { grade: { code: 'asc' } }, { name: 'asc' }],
    });

    const exams = await prisma.exam.findMany({
      where: { deletedAt: null },
      include: {
        lesson: { include: { chapter: { include: { grade: true } } } },
      },
    });
    
    res.json({
      classes: classes.map((c) => ({
        id: c.id,
        name: c.name,
        school: c.school?.name ?? '',
        gradeLevel: c.grade?.code ?? '',
        academicYearName: c.academicYear?.name ?? '',
      })),
      lessons: exams.map((exam) => serializeLessonExam(exam)),
    });
  } catch (error) {
    console.error('Filters error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/stats', authenticate, requireRole('TEACHER'), async (req, res) => {
  try {
    const { school, academicYearName, gradeLevel, classId } = req.query;

    const classWhere = {};
    if (classId && classId !== 'ALL') {
      classWhere.id = parseInt(classId, 10);
    } else {
      if (school) classWhere.school = { name: school };
      if (academicYearName) classWhere.academicYear = { name: academicYearName };
      if (gradeLevel) classWhere.grade = { code: gradeLevel };
    }

    const students = await prisma.user.findMany({
      where: { 
        role: 'STUDENT', 
        deletedAt: null,
        studentClass: classWhere,
      },
      include: {
        studentClass: {
          include: { school: true, grade: true, academicYear: true },
        },
      },
      orderBy: { fullName: 'asc' },
    });

    const exams = await prisma.exam.findMany({
      where: { deletedAt: null },
      include: {
        lesson: { include: { chapter: { include: { grade: true } } } },
        assignments: {
          include: {
            studentClass: { include: { school: true, grade: true, academicYear: true } },
          },
        },
        _count: { select: { nodes: true } },
      },
    });

    const serializedLessons = exams.map((exam) => serializeLessonExam(exam));
    const attempts = await prisma.attempt.findMany({
      where: { userId: { in: students.map((s) => s.id) } },
      orderBy: { createdAt: 'asc' },
    });

    const rows = students.map((student) => {
      const studentAttempts = attempts.filter((a) => a.userId === student.id);
      const lessonStats = serializedLessons.map((lesson) => {
        const completed = studentAttempts.filter((a) => a.examId === lesson.id && a.isComplete);
        const inProgress = studentAttempts.filter((a) => a.examId === lesson.id && !a.isComplete);
        const summary = buildAttemptSummary(completed);

        return {
          examId: lesson.id,
          status: inProgress.length > 0 ? 'IN_PROGRESS' : completed.length > 0 ? 'COMPLETED' : 'NOT_STARTED',
          ...summary,
        };
      });

      return {
        studentId: student.id,
        fullName: student.fullName,
        username: student.username,
        classId: student.studentClass?.id ?? null,
        className: student.studentClass?.name ?? '',
        school: student.studentClass?.school?.name ?? '',
        gradeLevel: student.studentClass?.grade?.code ?? '',
        academicYearName: student.studentClass?.academicYear?.name ?? '',
        lessonStats,
      };
    });

    res.json({ rows, lessons: serializedLessons });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/node-stats', authenticate, requireRole('TEACHER'), async (req, res) => {
  try {
    const examId = parseInt(req.query.examId, 10);
    const classId = parseInt(req.query.classId, 10);
    if (Number.isNaN(examId)) return res.status(400).json({ error: 'examId là bắt buộc' });

    const exam = await prisma.exam.findUnique({
      where: { id: examId, deletedAt: null },
      include: {
        lesson: { include: { chapter: { include: { grade: true } } } },
        nodes: { orderBy: [{ parentId: 'asc' }, { order: 'asc' }] },
      },
    });
    if (!exam) return res.status(404).json({ error: 'Không tìm thấy bài tập' });

    const students = await prisma.user.findMany({
      where: {
        role: 'STUDENT',
        deletedAt: null,
        ...(classId && !isNaN(classId) ? { classId } : {}),
      },
      select: { id: true, fullName: true, studentClass: { select: { name: true } } },
    });
    const studentIds = students.map((student) => student.id);

    const attempts = await prisma.attempt.findMany({
      where: { examId, userId: { in: studentIds }, isComplete: true },
      orderBy: { createdAt: 'desc' },
      select: { id: true, userId: true, score: true },
    });
    
    const latestAttempts = [];
    const seenUsers = new Set();
    for (const a of attempts) {
      if (!seenUsers.has(a.userId)) {
        latestAttempts.push(a);
        seenUsers.add(a.userId);
      }
    }
    const attemptIds = latestAttempts.map((attempt) => attempt.id);

    const nodeAnswers = await prisma.nodeAnswer.findMany({
      where: { attemptId: { in: attemptIds } },
      select: { nodeId: true, isCorrect: true, attemptId: true },
    });

    const nodeMap = new Map(exam.nodes.map(n => [n.id, n]));

    const nodeStats = exam.nodes.map((node) => {
      const answers = nodeAnswers.filter((item) => item.nodeId === node.id);
      const total = answers.length;
      const correct = answers.filter((item) => item.isCorrect).length;
      const incorrect = total - correct;
      return {
        nodeId: node.id,
        label: node.label,
        question: node.question,
        parentId: node.parentId,
        total,
        correct,
        incorrect,
        errorRate: total > 0 ? parseFloat(((incorrect / total) * 100).toFixed(1)) : null,
      };
    });

    const studentMistakes = latestAttempts.map(attempt => {
      const answers = nodeAnswers.filter(na => na.attemptId === attempt.id);
      const wrongAnswers = answers.filter(na => !na.isCorrect).map(na => {
        const node = nodeMap.get(na.nodeId);
        return { nodeId: node.id, label: node?.label, question: node?.question };
      });
      const student = students.find(s => s.id === attempt.userId);
      return {
        studentId: student.id,
        fullName: student.fullName,
        className: student.studentClass?.name,
        score: attempt.score,
        wrongAnswers
      };
    }).sort((a, b) => a.score - b.score);

    res.json({
      exam: {
        id: exam.id,
        title: exam.title,
        lessonTitle: exam.lesson.title,
        chapterTitle: exam.lesson.chapter.title,
        gradeLevel: exam.lesson.chapter.grade.code,
      },
      nodeStats,
      studentMistakes,
    });
  } catch (error) {
    console.error('Node stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
