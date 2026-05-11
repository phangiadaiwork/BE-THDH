const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const { PrismaClient } = require('@prisma/client');
const { authenticate, requireRole } = require('../middleware/auth');
const {
  ensureGrade,
  normalizeText,
  parseOptionalInt,
  serializeLessonExam,
} = require('../utils/education');

const router = express.Router();
const prisma = new PrismaClient();
const upload = multer({ storage: multer.memoryStorage() });

function slugifyChapterCode(value) {
  return normalizeText(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeExamPayload(body = {}) {
  return {
    gradeLevel: normalizeText(body.gradeLevel, '12'),
    chapterTitle: normalizeText(body.chapterTitle),
    chapterCode: slugifyChapterCode(body.chapterCode || body.chapterTitle),
    chapterDisplayOrder: parseOptionalInt(body.chapterDisplayOrder) ?? 0,
    lessonNumber: parseOptionalInt(body.lessonNumber),
    lessonTitle: normalizeText(body.lessonTitle || body.title),
    exerciseTitle: normalizeText(body.exerciseTitle, 'Bài tập'),
    theoryContent: String(body.theoryContent ?? '').trim(),
    theoryPdf: body.theoryPdf || null,
    displayOrder: parseOptionalInt(body.displayOrder),
    title: normalizeText(body.title || body.lessonTitle),
    isPublic: body.isPublic === undefined ? true : Boolean(body.isPublic),
  };
}

function validateExamMetadata(payload) {
  if (!['10', '11', '12'].includes(payload.gradeLevel)) return 'Khối lớp chỉ nhận 10, 11 hoặc 12';
  if (!payload.chapterTitle) return 'Tên chương là bắt buộc';
  if (!payload.chapterCode) return 'Mã chương là bắt buộc';
  if (!payload.lessonTitle) return 'Tên bài học là bắt buộc';
  if (payload.lessonNumber !== null && payload.lessonNumber <= 0) return 'Số bài phải lớn hơn 0';
  return null;
}

function normalizeOptionValues(node) {
  if (Array.isArray(node.options)) return node.options;

  const rawOptions = ['optionA', 'optionB', 'optionC', 'optionD']
    .map((key) => normalizeText(node[key]))
    .filter(Boolean);

  return rawOptions;
}

function stripHtmlTags(value = '') {
  return String(value).replace(/<[^>]*>/g, ' ');
}

function hasMeaningfulRichText(value = '') {
  const text = stripHtmlTags(value)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 0;
}

function normalizeNodeInput(node, index = 0) {
  return {
    tempId: normalizeText(node.tempId || node.nodeId, `node-${index + 1}`),
    parentTempId: normalizeText(node.parentTempId || node.parentNodeId) || null,
    label: normalizeText(node.label),
    question: normalizeText(node.question),
    questionImage: node.questionImage || null,
    options: normalizeOptionValues(node),
    optionImages: Array.isArray(node.optionImages) ? node.optionImages : null,
    correctAnswer: normalizeText(node.correctAnswer).toUpperCase(),
    answerImage: node.answerImage || null,
    hint: normalizeText(node.hint),
    hintImage: node.hintImage || null,
    points: Math.max(1, parseInt(node.points, 10) || 1),
    order: parseOptionalInt(node.order) ?? index,
  };
}

function validateNodes(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return 'Cần ít nhất một node';
  }

  const tempIds = new Set();
  const roots = [];

  for (const node of nodes) {
    if (!node.tempId) return 'Mỗi node phải có mã định danh';
    if (tempIds.has(node.tempId)) return `Trùng nodeId/tempId: ${node.tempId}`;
    tempIds.add(node.tempId);

    if (!node.parentTempId) roots.push(node.tempId);
    if (!node.label) return `Node ${node.tempId} thiếu nhãn`;
    
    const hasQText = hasMeaningfulRichText(node.question);
    const hasQImg = !!node.questionImage;
    const isQuestionNode = hasQText || hasQImg;

    if (isQuestionNode && !node.correctAnswer) {
      return `Node ${node.tempId} có câu hỏi nhưng thiếu đáp án đúng`;
    }
    
    if (node.parentTempId && node.parentTempId === node.tempId) {
      return `Node ${node.tempId} không thể là cha của chính nó`;
    }

    const hasOptions = Array.isArray(node.options) && node.options.length > 0;
    if (hasOptions) {
      const meaningfulOptions = node.options.filter((option) => hasMeaningfulRichText(option));
      if (meaningfulOptions.length < 2 || meaningfulOptions.length > 4) {
        return `Node ${node.tempId} phải có từ 2 đến 4 phương án`;
      }
      if (!['A', 'B', 'C', 'D'].includes(node.correctAnswer)) {
        return `Node ${node.tempId} phải có đáp án đúng là A, B, C hoặc D`;
      }
      const correctIndex = ['A', 'B', 'C', 'D'].indexOf(node.correctAnswer);
      if (correctIndex < 0 || correctIndex >= meaningfulOptions.length) {
        return `Node ${node.tempId} có đáp án đúng không khớp với danh sách phương án`;
      }
    }
  }

  if (roots.length !== 1) return 'Cây bài tập phải có đúng 1 node gốc';

  for (const node of nodes) {
    if (node.parentTempId && !tempIds.has(node.parentTempId)) {
      return `Node ${node.tempId} tham chiếu parent không tồn tại: ${node.parentTempId}`;
    }
  }

  return null;
}

async function ensureChapterAndLesson(payload, examIdToIgnore = null) {
  const metaError = validateExamMetadata(payload);
  if (metaError) {
    const error = new Error(metaError);
    error.statusCode = 400;
    throw error;
  }

  const grade = await ensureGrade(prisma, payload.gradeLevel);

  const chapter = await prisma.chapter.upsert({
    where: { gradeId_code: { gradeId: grade.id, code: payload.chapterCode } },
    update: {
      title: payload.chapterTitle,
      displayOrder: payload.chapterDisplayOrder,
    },
    create: {
      gradeId: grade.id,
      code: payload.chapterCode,
      title: payload.chapterTitle,
      displayOrder: payload.chapterDisplayOrder,
    },
  });

  const lessonDisplayOrder = payload.displayOrder ?? payload.lessonNumber ?? 0;

  const lesson = await prisma.lesson.upsert({
    where: {
      chapterId_title: {
        chapterId: chapter.id,
        title: payload.lessonTitle,
      },
    },
    update: {
      number: payload.lessonNumber,
      theoryContent: payload.theoryContent,
      theoryPdf: payload.theoryPdf || null,
      displayOrder: lessonDisplayOrder,
    },
    create: {
      chapterId: chapter.id,
      number: payload.lessonNumber,
      title: payload.lessonTitle,
      theoryContent: payload.theoryContent,
      theoryPdf: payload.theoryPdf || null,
      displayOrder: lessonDisplayOrder,
    },
  });

  const existingExam = await prisma.exam.findUnique({
    where: { lessonId: lesson.id },
  });

  if (existingExam && existingExam.id !== examIdToIgnore) {
    const error = new Error('Bài học này đã có bộ bài tập');
    error.statusCode = 400;
    throw error;
  }

  return { lesson };
}

async function buildExamWhereForUser(userId, role) {
  if (role !== 'STUDENT') return {};

  const student = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: { classId: true },
  });

  if (!student?.classId) return { isPublic: true };

  return {
    OR: [
      { isPublic: true },
      { assignments: { some: { classId: student.classId } } },
    ],
  };
}

async function fetchExamList(where = {}) {
  const exams = await prisma.exam.findMany({
    where: { ...where, deletedAt: null },
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
              academicYear: true,
            },
          },
        },
      },
      _count: { select: { nodes: true } },
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
    if (!grouped[attempt.examId]) grouped[attempt.examId] = { completed: [], inProgress: [] };
    if (attempt.isComplete) grouped[attempt.examId].completed.push(attempt);
    else grouped[attempt.examId].inProgress.push(attempt);
  });

  const result = {};
  Object.entries(grouped).forEach(([examId, item]) => {
    const total = item.completed.reduce((sum, attempt) => sum + attempt.score, 0);
    const bestScore = item.completed.length > 0 ? Math.max(...item.completed.map((attempt) => attempt.score)) : null;
    const lastAttempt = item.completed.length > 0 ? item.completed[item.completed.length - 1] : null;
    result[parseInt(examId, 10)] = {
      status: item.inProgress.length > 0 ? 'IN_PROGRESS' : item.completed.length > 0 ? 'COMPLETED' : 'NOT_STARTED',
      attemptCount: item.completed.length,
      avgScore: item.completed.length > 0 ? parseFloat((total / item.completed.length).toFixed(2)) : null,
      bestScore,
      lastScore: lastAttempt?.score ?? null,
      lastCompletedAt: lastAttempt?.createdAt ?? null,
      canReview: item.inProgress.length === 0 && item.completed.length > 0,
    };
  });
  return result;
}

async function createExamWithNodes(payload, normalizedNodes) {
  const { lesson } = await ensureChapterAndLesson(payload);

  const exam = await prisma.exam.create({
    data: {
      lessonId: lesson.id,
      title: normalizeText(payload.title || lesson.title, lesson.title),
      exerciseTitle: payload.exerciseTitle,
      isPublic: payload.isPublic,
    },
  });

  const nodesById = Object.fromEntries(normalizedNodes.map((node) => [node.tempId, node]));
  const roots = normalizedNodes.filter((node) => !node.parentTempId);
  const idMap = {};
  const queue = roots.map((root) => root.tempId);
  const processed = new Set();

  while (queue.length > 0) {
    const tempId = queue.shift();
    if (processed.has(tempId)) continue;

    const node = nodesById[tempId];
    const parentId = node.parentTempId ? idMap[node.parentTempId] : null;

    const created = await prisma.mindNode.create({
      data: {
        examId: exam.id,
        parentId,
        label: node.label,
        question: node.question,
        questionImage: node.questionImage,
        options: node.options.length > 0 ? node.options : null,
        optionImages: node.optionImages,
        correctAnswer: node.correctAnswer,
        answerImage: node.answerImage,
        hint: node.hint,
        hintImage: node.hintImage,
        points: node.points,
        order: node.order,
      },
    });

    idMap[tempId] = created.id;
    processed.add(tempId);

    normalizedNodes
      .filter((child) => child.parentTempId === tempId && !processed.has(child.tempId))
      .sort((a, b) => a.order - b.order)
      .forEach((child) => queue.push(child.tempId));
  }

  return prisma.exam.findUnique({
    where: { id: exam.id },
    include: {
      lesson: { include: { chapter: { include: { grade: true } } } },
      assignments: {
        include: {
          studentClass: { include: { school: true, grade: true, academicYear: true } },
        },
      },
      nodes: { orderBy: [{ parentId: 'asc' }, { order: 'asc' }] },
      _count: { select: { nodes: true } },
    },
  });
}

async function updateExamWithNodes(examId, payload, normalizedNodes) {
  const { lesson } = await ensureChapterAndLesson(payload, examId);

  const exam = await prisma.exam.update({
    where: { id: examId },
    data: {
      lessonId: lesson.id,
      title: normalizeText(payload.title || lesson.title, lesson.title),
      exerciseTitle: payload.exerciseTitle,
      isPublic: payload.isPublic,
    },
  });

  const nodesById = Object.fromEntries(normalizedNodes.map((node) => [node.tempId, node]));
  const roots = normalizedNodes.filter((node) => !node.parentTempId);
  const idMap = {};
  const queue = roots.map((root) => root.tempId);
  const processed = new Set();

  const existingNodes = await prisma.mindNode.findMany({ where: { examId } });
  const existingNodeIds = new Set(existingNodes.map((n) => n.id));
  const nodesToKeep = new Set();

  while (queue.length > 0) {
    const tempId = queue.shift();
    if (processed.has(tempId)) continue;

    const node = nodesById[tempId];
    const parentId = node.parentTempId ? idMap[node.parentTempId] : null;

    const parsedId = parseInt(tempId, 10);
    const isExistingId = !Number.isNaN(parsedId) && existingNodeIds.has(parsedId);

    let dbNodeId;

    if (isExistingId) {
      await prisma.mindNode.update({
        where: { id: parsedId },
        data: {
          parentId,
          label: node.label,
          question: node.question,
          questionImage: node.questionImage,
          options: node.options.length > 0 ? node.options : null,
          optionImages: node.optionImages,
          correctAnswer: node.correctAnswer,
          answerImage: node.answerImage,
          hint: node.hint,
          hintImage: node.hintImage,
          points: node.points,
          order: node.order,
        },
      });
      dbNodeId = parsedId;
      nodesToKeep.add(parsedId);
    } else {
      const created = await prisma.mindNode.create({
        data: {
          examId: exam.id,
          parentId,
          label: node.label,
          question: node.question,
          questionImage: node.questionImage,
          options: node.options.length > 0 ? node.options : null,
          optionImages: node.optionImages,
          correctAnswer: node.correctAnswer,
          answerImage: node.answerImage,
          hint: node.hint,
          hintImage: node.hintImage,
          points: node.points,
          order: node.order,
        },
      });
      dbNodeId = created.id;
      nodesToKeep.add(dbNodeId);
    }

    idMap[tempId] = dbNodeId;
    processed.add(tempId);

    normalizedNodes
      .filter((child) => child.parentTempId === tempId && !processed.has(child.tempId))
      .sort((a, b) => a.order - b.order)
      .forEach((child) => queue.push(child.tempId));
  }

  const nodesToDelete = Array.from(existingNodeIds).filter((id) => !nodesToKeep.has(id));
  if (nodesToDelete.length > 0) {
    await prisma.mindNode.deleteMany({
      where: { id: { in: nodesToDelete } },
    });
  }

  return prisma.exam.findUnique({
    where: { id: exam.id },
    include: {
      lesson: { include: { chapter: { include: { grade: true } } } },
      assignments: {
        include: {
          studentClass: { include: { school: true, grade: true, academicYear: true } },
        },
      },
      nodes: { orderBy: [{ parentId: 'asc' }, { order: 'asc' }] },
      _count: { select: { nodes: true } },
    },
  });
}

router.get('/meta', authenticate, requireRole('TEACHER'), async (_req, res) => {
  try {
    const schools = await prisma.school.findMany({ orderBy: { name: 'asc' } });
    res.json({
      schools,
      grades: ['10', '11', '12'],
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', authenticate, requireRole('TEACHER'), async (req, res) => {
  try {
    const payload = normalizeExamPayload(req.body);
    const normalizedNodes = (req.body.nodes || []).map(normalizeNodeInput);
    const nodeError = validateNodes(normalizedNodes);
    if (nodeError) return res.status(400).json({ error: nodeError });

    const fullExam = await createExamWithNodes(payload, normalizedNodes);
    res.status(201).json({
      ...serializeLessonExam(fullExam),
      nodes: fullExam.nodes,
    });
  } catch (error) {
    console.error('Create exam error:', error);
    res.status(error.statusCode || 500).json({ error: error.message || 'Internal server error' });
  }
});

router.put('/:id', authenticate, requireRole('TEACHER'), async (req, res) => {
  try {
    const examId = parseInt(req.params.id, 10);
    if (Number.isNaN(examId)) return res.status(400).json({ error: 'ID không hợp lệ' });

    const existingExam = await prisma.exam.findFirst({
      where: { id: examId, deletedAt: null },
    });
    if (!existingExam) return res.status(404).json({ error: 'Không tìm thấy bài học' });

    const payload = normalizeExamPayload(req.body);
    const normalizedNodes = (req.body.nodes || []).map(normalizeNodeInput);
    const nodeError = validateNodes(normalizedNodes);
    if (nodeError) return res.status(400).json({ error: nodeError });

    const fullExam = await updateExamWithNodes(examId, payload, normalizedNodes);
    res.json({
      ...serializeLessonExam(fullExam),
      nodes: fullExam.nodes,
    });
  } catch (error) {
    console.error('Update exam error:', error);
    res.status(error.statusCode || 500).json({ error: error.message || 'Internal server error' });
  }
});

router.get('/template', authenticate, requireRole('TEACHER'), (_req, res) => {
  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.aoa_to_sheet([
    ['nodeId', 'parentNodeId', 'label', 'question', 'optionA', 'optionB', 'optionC', 'optionD', 'correctAnswer', 'hint', 'points', 'order'],
    ['1', '', 'Chủ đề chính', 'Câu hỏi gốc?', 'Đáp án A', 'Đáp án B', 'Đáp án C', 'Đáp án D', 'A', 'Gợi ý...', '1', '0'],
    ['2', '1', 'Nhánh 1', 'Câu hỏi nhánh 1?', 'Đáp án A', 'Đáp án B', 'Đáp án C', 'Đáp án D', 'B', '', '2', '0'],
    ['3', '1', 'Nhánh 2', 'Câu hỏi nhánh 2?', '', '', '', '', 'Đáp án tự luận', 'Gợi ý ngắn', '1', '1'],
  ]);
  ws['!cols'] = [{ wch: 10 }, { wch: 14 }, { wch: 20 }, { wch: 30 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 20 }, { wch: 8 }, { wch: 8 }];
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

    const normalizedNodes = rows.map((row, index) => normalizeNodeInput(row, index));
    const nodeError = validateNodes(normalizedNodes);
    if (nodeError) return res.status(400).json({ error: nodeError });

    res.status(200).json({ nodes: normalizedNodes });
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
        where: { userId: req.user.id, examId: { in: lessons.map((lesson) => lesson.id) } },
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
      where: { id, deletedAt: null, ...where },
      include: {
        lesson: { include: { chapter: { include: { grade: true } } } },
        assignments: {
          include: {
            studentClass: { include: { school: true, grade: true, academicYear: true } },
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

    const existingExam = await prisma.exam.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });

    if (!existingExam) {
      return res.status(404).json({ error: 'Không tìm thấy bài học' });
    }

    await prisma.exam.update({
      where: { id },
      data: {
        isPublic: Boolean(isPublic),
        assignments: {
          deleteMany: {},
          create: classRecords.map((studentClass) => ({ classId: studentClass.id })),
        },
      },
    });

    const exam = await prisma.exam.findFirst({
      where: { id, deletedAt: null },
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

    res.json(serializeLessonExam(exam));
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', authenticate, requireRole('TEACHER'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID không hợp lệ' });

    const result = await prisma.exam.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    if (result.count === 0) {
      return res.status(404).json({ error: 'Không tìm thấy bài học' });
    }

    res.json({ message: 'Đã xóa mềm bài học' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
