const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const { PrismaClient } = require('@prisma/client');
const { authenticate, requireRole } = require('../middleware/auth');
const {
  ensureGrade,
  normalizeText,
  serializeLessonExam,
} = require('../utils/education');

const router = express.Router();
const prisma = new PrismaClient();
const upload = multer({ storage: multer.memoryStorage() });

function parseOptionalInt(value) {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

async function ensureChapterAndLesson(body) {
  const gradeCode = normalizeText(body.gradeLevel, '12');
  const grade = await ensureGrade(prisma, gradeCode);

  const chapterCode = normalizeText(
    body.chapterCode || body.chapterKey || body.chapterTitle?.toLowerCase().replace(/\s+/g, '-'),
    'chuong-1'
  );
  const chapterTitle = normalizeText(body.chapterTitle, 'Chương I');
  const chapterDisplayOrder = parseOptionalInt(body.chapterDisplayOrder) ?? 0;

  const chapter = await prisma.chapter.upsert({
    where: { gradeId_code: { gradeId: grade.id, code: chapterCode } },
    update: {
      title: chapterTitle,
      displayOrder: chapterDisplayOrder,
    },
    create: {
      gradeId: grade.id,
      code: chapterCode,
      title: chapterTitle,
      displayOrder: chapterDisplayOrder,
    },
  });

  const lessonTitle = normalizeText(body.lessonTitle || body.title, 'Bài học');
  const lessonNumber = parseOptionalInt(body.lessonNumber);
  const displayOrder = parseOptionalInt(body.displayOrder) ?? lessonNumber ?? 0;

  const existingLesson = await prisma.lesson.findFirst({
    where: {
      chapterId: chapter.id,
      OR: [
        { title: lessonTitle },
        ...(lessonNumber === null ? [] : [{ number: lessonNumber }]),
      ],
    },
    include: { exam: true },
  });

  if (existingLesson?.exam) {
    const error = new Error('Bài học này đã có bài tập');
    error.statusCode = 400;
    throw error;
  }

  if (existingLesson) {
    return prisma.lesson.update({
      where: { id: existingLesson.id },
      data: {
        number: lessonNumber,
        title: lessonTitle,
        theoryContent: String(body.theoryContent ?? '').trim(),
        displayOrder,
      },
    });
  }

  return prisma.lesson.create({
    data: {
      chapterId: chapter.id,
      number: lessonNumber,
      title: lessonTitle,
      theoryContent: String(body.theoryContent ?? '').trim(),
      displayOrder,
    },
  });
}

async function findVisibleClassIds(examId) {
  const assignments = await prisma.examAssignment.findMany({
    where: { examId },
    select: { classId: true },
  });
  return new Set(assignments.map((item) => item.classId));
}

async function buildExamWhereForUser(userId, role) {
  if (role !== 'STUDENT') return {};

  const student = await prisma.user.findUnique({
    where: { id: userId },
    select: { classId: true },
  });

  if (!student?.classId) {
    return { isPublic: true };
  }

  return {
    OR: [
      { isPublic: true },
      { assignments: { some: { classId: student.classId } } },
    ],
  };
}

async function fetchExamList(where = {}) {
  const exams = await prisma.exam.findMany({
    where,
    include: {
      lesson: {
        include: {
          chapter: {
            include: {
              grade: true,
            },
          },
        },
      },
      assignments: {
        include: {
          studentClass: {
            include: {
              school: true,
              grade: true,
            },
          },
        },
      },
      _count: {
        select: { nodes: true },
      },
    },
  });

  return exams
    .map((exam) => serializeLessonExam(exam))
    .sort((a, b) =>
      a.gradeLevel.localeCompare(b.gradeLevel, 'vi') ||
      a.chapterDisplayOrder - b.chapterDisplayOrder ||
      a.lessonDisplayOrder - b.lessonDisplayOrder ||
      (a.lessonNumber ?? 999) - (b.lessonNumber ?? 999) ||
      a.lessonTitle.localeCompare(b.lessonTitle, 'vi')
    );
}

function summarizeAttempts(attempts) {
  const grouped = {};

  attempts.forEach((attempt) => {
    if (!grouped[attempt.examId]) {
      grouped[attempt.examId] = {
        completed: [],
        inProgress: [],
      };
    }

    if (attempt.isComplete) grouped[attempt.examId].completed.push(attempt);
    else grouped[attempt.examId].inProgress.push(attempt);
  });

  const result = {};
  Object.entries(grouped).forEach(([examId, item]) => {
    const completed = item.completed;
    const total = completed.reduce((sum, attempt) => sum + attempt.score, 0);
    const bestScore = completed.length > 0 ? Math.max(...completed.map((attempt) => attempt.score)) : null;
    const lastAttempt = completed.length > 0 ? completed[completed.length - 1] : null;

    result[parseInt(examId, 10)] = {
      status: item.inProgress.length > 0 ? 'IN_PROGRESS' : completed.length > 0 ? 'COMPLETED' : 'NOT_STARTED',
      attemptCount: completed.length,
      avgScore: completed.length > 0 ? parseFloat((total / completed.length).toFixed(2)) : null,
      bestScore,
      lastScore: lastAttempt?.score ?? null,
      lastCompletedAt: lastAttempt?.createdAt ?? null,
      canReview: item.inProgress.length === 0 && completed.length > 0,
    };
  });

  return result;
}

router.post('/', authenticate, requireRole('TEACHER'), async (req, res) => {
  try {
    const { nodes } = req.body;

    if (!Array.isArray(nodes) || nodes.length === 0) {
      return res.status(400).json({ error: 'Cần ít nhất một node' });
    }

    const lesson = await ensureChapterAndLesson(req.body);
    const exam = await prisma.exam.create({
      data: {
        lessonId: lesson.id,
        title: normalizeText(req.body.title || lesson.title, lesson.title),
        exerciseTitle: normalizeText(req.body.exerciseTitle, 'Bài tập'),
        isPublic: req.body.isPublic === undefined ? true : Boolean(req.body.isPublic),
      },
    });

    const nodesById = {};
    nodes.forEach((node) => {
      nodesById[node.tempId] = node;
    });

    const roots = nodes.filter((node) => !node.parentTempId);
    if (roots.length === 0) {
      await prisma.exam.delete({ where: { id: exam.id } });
      return res.status(400).json({ error: 'Không tìm thấy node gốc' });
    }

    const idMap = {};
    const queue = roots.map((root) => root.tempId);
    const processed = new Set();

    while (queue.length > 0) {
      const tempId = queue.shift();
      if (processed.has(tempId)) continue;

      const node = nodesById[tempId];
      if (!node) continue;

      const parentId = node.parentTempId ? idMap[node.parentTempId] : null;

      const created = await prisma.mindNode.create({
        data: {
          examId: exam.id,
          parentId,
          label: normalizeText(node.label),
          question: normalizeText(node.question),
          options: node.options || null,
          correctAnswer: normalizeText(node.correctAnswer),
          hint: normalizeText(node.hint),
          points: Math.max(1, parseInt(node.points, 10) || 1),
          order: parseInt(node.order, 10) || 0,
        },
      });

      idMap[tempId] = created.id;
      processed.add(tempId);

      const children = nodes.filter(
        (item) => item.parentTempId === tempId && !processed.has(item.tempId)
      );
      queue.push(...children.map((child) => child.tempId));
    }

    const fullExam = await prisma.exam.findUnique({
      where: { id: exam.id },
      include: {
        lesson: {
          include: {
            chapter: {
              include: {
                grade: true,
              },
            },
          },
        },
        assignments: {
          include: {
            studentClass: {
              include: { school: true, grade: true },
            },
          },
        },
        nodes: { orderBy: [{ parentId: 'asc' }, { order: 'asc' }] },
        _count: { select: { nodes: true } },
      },
    });

    res.status(201).json({
      ...serializeLessonExam(fullExam),
      nodes: fullExam.nodes,
    });
  } catch (error) {
    console.error('Create exam error:', error);
    res.status(error.statusCode || 500).json({ error: error.message || 'Internal server error' });
  }
});

router.get('/template', authenticate, requireRole('TEACHER'), (_req, res) => {
  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.aoa_to_sheet([
    ['nodeId', 'parentNodeId', 'label', 'question', 'optionA', 'optionB', 'optionC', 'optionD', 'correctAnswer', 'hint', 'points'],
    ['1', '', 'Chủ đề chính', 'Câu hỏi gốc?', 'Đáp án A', 'Đáp án B', 'Đáp án C', 'Đáp án D', 'A', 'Gợi ý...', '1'],
    ['2', '1', 'Nhánh 1', 'Câu hỏi nhánh 1?', 'Đáp án A', 'Đáp án B', 'Đáp án C', 'Đáp án D', 'B', '', '2'],
  ]);
  ws['!cols'] = [{ wch: 8 }, { wch: 12 }, { wch: 16 }, { wch: 30 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 20 }, { wch: 7 }];
  xlsx.utils.book_append_sheet(wb, ws, 'BaiTap');
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="mau_bai_tap.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

router.post('/import', authenticate, requireRole('TEACHER'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Cần upload file Excel' });

    const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(ws, { defval: '' });

    if (rows.length === 0) return res.status(400).json({ error: 'File không có dữ liệu' });

    req.body.title = req.body.title || req.body.lessonTitle;
    const lesson = await ensureChapterAndLesson(req.body);
    const exam = await prisma.exam.create({
      data: {
        lessonId: lesson.id,
        title: normalizeText(req.body.title || lesson.title, lesson.title),
        exerciseTitle: normalizeText(req.body.exerciseTitle, 'Bài tập'),
        isPublic: req.body.isPublic === undefined ? true : Boolean(req.body.isPublic),
      },
    });

    const idMap = {};
    const ordersPerParent = {};

    for (const row of rows) {
      const tempId = normalizeText(row.nodeId);
      if (!tempId) continue;

      const parentTempId = normalizeText(row.parentNodeId);
      const parentId = parentTempId ? (idMap[parentTempId] ?? null) : null;
      const orderKey = parentTempId || 'root';
      if (!ordersPerParent[orderKey]) ordersPerParent[orderKey] = 0;
      const order = ordersPerParent[orderKey]++;

      const options = ['optionA', 'optionB', 'optionC', 'optionD']
        .map((key) => normalizeText(row[key]))
        .filter(Boolean)
        .map((option, index) => `${['A', 'B', 'C', 'D'][index]}. ${option}`);

      const created = await prisma.mindNode.create({
        data: {
          examId: exam.id,
          parentId,
          label: normalizeText(row.label, `Node ${tempId}`),
          question: normalizeText(row.question),
          options: options.length > 0 ? options : null,
          correctAnswer: normalizeText(row.correctAnswer),
          hint: normalizeText(row.hint),
          points: Math.max(1, parseInt(row.points, 10) || 1),
          order,
        },
      });
      idMap[tempId] = created.id;
    }

    const fullExam = await prisma.exam.findUnique({
      where: { id: exam.id },
      include: {
        lesson: {
          include: {
            chapter: {
              include: { grade: true },
            },
          },
        },
        assignments: {
          include: {
            studentClass: { include: { school: true, grade: true } },
          },
        },
        nodes: { orderBy: [{ parentId: 'asc' }, { order: 'asc' }] },
        _count: { select: { nodes: true } },
      },
    });

    res.status(201).json({
      ...serializeLessonExam(fullExam),
      nodes: fullExam.nodes,
    });
  } catch (error) {
    console.error('Import exam error:', error);
    res.status(error.statusCode || 500).json({ error: error.message || 'Internal server error' });
  }
});

router.get('/catalog', authenticate, async (req, res) => {
  try {
    const where = await buildExamWhereForUser(req.user.id, req.user.role);
    const lessons = await fetchExamList(where);
    let attemptSummaryByExam = {};

    if (req.user.role === 'STUDENT' && lessons.length > 0) {
      const attempts = await prisma.attempt.findMany({
        where: {
          userId: req.user.id,
          examId: { in: lessons.map((lesson) => lesson.id) },
        },
        orderBy: { createdAt: 'asc' },
      });
      attemptSummaryByExam = summarizeAttempts(attempts);
    }

    res.json({
      lessons: lessons.map((lesson) => ({
        ...lesson,
        attemptSummary: attemptSummaryByExam[lesson.id] || {
          status: 'NOT_STARTED',
          attemptCount: 0,
          avgScore: null,
          bestScore: null,
          lastScore: null,
          lastCompletedAt: null,
          canReview: false,
        },
      })),
    });
  } catch (error) {
    console.error('Get catalog error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/', authenticate, async (req, res) => {
  try {
    const where = await buildExamWhereForUser(req.user.id, req.user.role);
    const exams = await fetchExamList(where);
    res.json(exams);
  } catch (error) {
    console.error('Get exams error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID không hợp lệ' });

    const where = await buildExamWhereForUser(req.user.id, req.user.role);
    const exam = await prisma.exam.findFirst({
      where: { id, ...where },
      include: {
        lesson: {
          include: {
            chapter: {
              include: { grade: true },
            },
          },
        },
        assignments: {
          include: {
            studentClass: { include: { school: true, grade: true } },
          },
        },
        nodes: { orderBy: [{ parentId: 'asc' }, { order: 'asc' }] },
        _count: { select: { nodes: true } },
      },
    });

    if (!exam) return res.status(404).json({ error: 'Không tìm thấy bài học' });

    res.json({
      ...serializeLessonExam(exam),
      nodes: exam.nodes,
    });
  } catch (error) {
    console.error('Get exam error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id/visibility', authenticate, requireRole('TEACHER'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { isPublic, visibleClasses = [] } = req.body;

    const classRecords = visibleClasses.length > 0
      ? await prisma.studentClass.findMany({
          where: {
            OR: [
              { name: { in: visibleClasses.map((item) => normalizeText(item)) } },
              { id: { in: visibleClasses.map((item) => parseInt(item, 10)).filter((item) => !Number.isNaN(item)) } },
            ],
          },
        })
      : [];

    await prisma.exam.update({
      where: { id },
      data: {
        isPublic: Boolean(isPublic),
        assignments: {
          deleteMany: {},
          create: classRecords.map((studentClass) => ({
            classId: studentClass.id,
          })),
        },
      },
    });

    const exam = await prisma.exam.findUnique({
      where: { id },
      include: {
        lesson: { include: { chapter: { include: { grade: true } } } },
        assignments: {
          include: {
            studentClass: { include: { school: true, grade: true } },
          },
        },
        _count: { select: { nodes: true } },
      },
    });

    res.json(serializeLessonExam(exam));
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', authenticate, requireRole('TEACHER'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID không hợp lệ' });

    await prisma.exam.delete({ where: { id } });
    res.json({ message: 'Đã xóa bài học' });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Không tìm thấy bài học' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
