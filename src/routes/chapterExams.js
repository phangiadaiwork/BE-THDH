const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const { PrismaClient } = require('@prisma/client');
const { authenticate, requireRole } = require('../middleware/auth');
const { normalizeText, parseOptionalInt, ensureGrade } = require('../utils/education');

const router = express.Router();
const prisma = new PrismaClient();
const upload = multer({ storage: multer.memoryStorage() });

async function getStudentClassId(userId) {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: { classId: true },
  });
  return user?.classId ?? null;
}

// ----------------------------------------------------
// 1. GET /api/chapter-exams - Danh sách bài kiểm tra chương
// ----------------------------------------------------
router.get('/', authenticate, async (req, res) => {
  try {
    const { gradeLevel, chapterId } = req.query;
    const userId = req.user.id;
    const role = req.user.role;

    const where = { deletedAt: null };

    if (chapterId && !Number.isNaN(parseInt(chapterId, 10))) {
      where.chapterId = parseInt(chapterId, 10);
    } else if (gradeLevel) {
      const gNum = String(gradeLevel).replace(/\D/g, '');
      where.chapter = {
        grade: {
          OR: [
            { code: gNum || String(gradeLevel) },
            { code: String(gradeLevel) },
            { title: { contains: gNum || String(gradeLevel) } },
          ],
        },
      };
    }

    if (role === 'STUDENT') {
      const classId = await getStudentClassId(userId);
      where.OR = [
        { isPublic: true },
        ...(classId ? [{ assignments: { some: { classId } } }] : []),
      ];
    }

    const exams = await prisma.chapterExam.findMany({
      where,
      include: {
        chapter: {
          include: { grade: true },
        },
        assignments: {
          include: {
            studentClass: {
              include: { school: true, grade: true, academicYear: true },
            },
          },
        },
        _count: {
          select: { questions: true, attempts: true },
        },
      },
      orderBy: [
        { chapter: { displayOrder: 'asc' } },
        { createdAt: 'desc' },
      ],
    });

    let studentAttempts = [];
    if (role === 'STUDENT') {
      studentAttempts = await prisma.chapterExamAttempt.findMany({
        where: {
          userId,
          chapterExamId: { in: exams.map((e) => e.id) },
        },
        orderBy: { createdAt: 'desc' },
      });
    }

    const data = exams.map((exam) => {
      let myAttempt = null;
      let attemptCount = 0;
      let canRetake = true;

      if (role === 'STUDENT') {
        const userAttempts = studentAttempts.filter((a) => a.chapterExamId === exam.id);
        const completedAttempts = userAttempts.filter((a) => a.isComplete);
        const inProgressAttempt = userAttempts.find((a) => !a.isComplete);
        attemptCount = completedAttempts.length;

        // Điểm cao nhất trong các lần hoàn thành (Best Score) hoặc lượt đang làm dở
        const bestAttempt = completedAttempts.length > 0
          ? [...completedAttempts].sort((a, b) => (b.score || 0) - (a.score || 0))[0]
          : null;

        const activeAttempt = inProgressAttempt || bestAttempt || null;
        if (activeAttempt) {
          myAttempt = {
            id: activeAttempt.id,
            isComplete: activeAttempt.isComplete,
            score: activeAttempt.score,
            correctCount: activeAttempt.correctCount,
            totalCount: activeAttempt.totalCount,
            outCount: activeAttempt.outCount,
            startedAt: activeAttempt.startedAt,
            submittedAt: activeAttempt.submittedAt,
            durationSpent: activeAttempt.durationSpent,
          };
        }

        const max = exam.maxAttempts ?? 1;
        canRetake = Boolean(inProgressAttempt || max === 0 || attemptCount < max);
      }

      return {
        id: exam.id,
        chapterId: exam.chapterId,
        chapterTitle: exam.chapter?.title || '',
        chapterCode: exam.chapter?.code || '',
        gradeLevel: exam.chapter?.grade?.code || '',
        title: exam.title,
        description: exam.description || '',
        duration: exam.duration,
        isPublic: exam.isPublic,
        maxAttempts: exam.maxAttempts ?? 1,
        attemptCount,
        canRetake,
        questionCount: exam._count.questions,
        totalAttempts: exam._count.attempts,
        createdAt: exam.createdAt,
        assignedClasses: exam.assignments.map((a) => ({
          id: a.studentClass.id,
          name: a.studentClass.name,
          school: a.studentClass.school.name,
          academicYear: a.studentClass.academicYear.name,
        })),
        myAttempt,
      };
    });

    res.json({ exams: data });
  } catch (error) {
    console.error('List chapter exams error:', error);
    res.status(500).json({ error: 'Không thể tải danh sách bài kiểm tra chương' });
  }
});

// ----------------------------------------------------
// GET /api/chapter-exams/available-chapters?gradeLevel=12 - Danh sách chương hiện có
// (PHẢI ĐẶT TRƯỚC /:id để Express không nhầm với param)
// ----------------------------------------------------
router.get('/available-chapters', authenticate, requireRole('TEACHER'), async (req, res) => {
  try {
    const rawGrade = String(req.query.gradeLevel || '').trim();
    const cleanGradeNum = rawGrade.replace(/\D/g, '');

    const where = {};
    if (cleanGradeNum) {
      where.OR = [
        { grade: { code: cleanGradeNum } },
        { grade: { code: rawGrade } },
        { grade: { title: { contains: cleanGradeNum } } },
      ];
    }

    let chapters = await prisma.chapter.findMany({
      where,
      include: {
        grade: true,
        _count: { select: { lessons: true } },
      },
      orderBy: [
        { displayOrder: 'asc' },
        { title: 'asc' },
      ],
    });

    // Fallback: nếu danh sách trống và có cleanGradeNum, quét qua bảng Lesson
    if (chapters.length === 0 && cleanGradeNum) {
      const lessons = await prisma.lesson.findMany({
        where: {
          chapter: {
            OR: [
              { grade: { code: cleanGradeNum } },
              { grade: { code: rawGrade } },
              { grade: { title: { contains: cleanGradeNum } } },
            ],
          },
        },
        include: {
          chapter: {
            include: { grade: true },
          },
        },
      });

      const map = new Map();
      lessons.forEach((l) => {
        if (l.chapter && !map.has(l.chapter.id)) {
          map.set(l.chapter.id, l.chapter);
        }
      });
      chapters = Array.from(map.values());
    }

    // Nếu vẫn trống (ví dụ gradeLevel không truyền hoặc DB chứa chapter độc lập)
    if (chapters.length === 0 && !cleanGradeNum) {
      chapters = await prisma.chapter.findMany({
        include: { grade: true },
        orderBy: [{ displayOrder: 'asc' }, { title: 'asc' }],
      });
    }

    res.json({
      chapters: chapters.map((c) => ({
        id: c.id,
        code: c.code || `chapter-${c.id}`,
        title: c.title,
        displayOrder: c.displayOrder ?? 0,
        gradeLevel: c.grade?.code || cleanGradeNum || '12',
        lessonCount: c._count?.lessons ?? 0,
      })),
    });
  } catch (error) {
    console.error('Available chapters error:', error);
    res.status(500).json({ error: 'Không thể tải danh sách chương' });
  }
});

// ----------------------------------------------------
// 2. GET /api/chapter-exams/:id - Chi tiết bài kiểm tra
// ----------------------------------------------------
router.get('/:id', authenticate, async (req, res) => {
  try {
    const examId = parseInt(req.params.id, 10);
    if (Number.isNaN(examId)) return res.status(400).json({ error: 'Mã bài kiểm tra không hợp lệ' });

    const role = req.user.role;
    const userId = req.user.id;

    const exam = await prisma.chapterExam.findFirst({
      where: { id: examId, deletedAt: null },
      include: {
        chapter: { include: { grade: true } },
        assignments: {
          include: {
            studentClass: {
              include: { school: true, grade: true, academicYear: true },
            },
          },
        },
        questions: {
          orderBy: { order: 'asc' },
        },
      },
    });

    if (!exam) {
      return res.status(404).json({ error: 'Không tìm thấy bài kiểm tra chương' });
    }

    if (role === 'STUDENT' && !exam.isPublic) {
      const classId = await getStudentClassId(userId);
      const isAssigned = exam.assignments.some((a) => a.classId === classId);
      if (!isAssigned) {
        return res.status(403).json({ error: 'Bạn không có quyền truy cập bài kiểm tra này' });
      }
    }

    // Hide answers if student and not finished
    const questions = exam.questions.map((q) => ({
      id: q.id,
      content: q.content,
      image: q.image,
      options: q.options,
      optionImages: q.optionImages,
      points: q.points,
      order: q.order,
      ...(role === 'TEACHER'
        ? {
            correctAnswer: q.correctAnswer,
            explanation: q.explanation,
            explanationImage: q.explanationImage,
          }
        : {}),
    }));

    let myAttempt = null;
    let attemptCount = 0;
    let canRetake = true;

    if (role === 'STUDENT') {
      const userAttempts = await prisma.chapterExamAttempt.findMany({
        where: { userId, chapterExamId: examId },
        orderBy: { createdAt: 'desc' },
      });
      const completedAttempts = userAttempts.filter((a) => a.isComplete);
      const inProgressAttempt = userAttempts.find((a) => !a.isComplete);
      attemptCount = completedAttempts.length;

      const bestAttempt = completedAttempts.length > 0
        ? [...completedAttempts].sort((a, b) => (b.score || 0) - (a.score || 0))[0]
        : null;

      const activeAttempt = inProgressAttempt || bestAttempt || null;
      if (activeAttempt) {
        myAttempt = {
          id: activeAttempt.id,
          isComplete: activeAttempt.isComplete,
          score: activeAttempt.score,
          correctCount: activeAttempt.correctCount,
          totalCount: activeAttempt.totalCount,
          outCount: activeAttempt.outCount,
          startedAt: activeAttempt.startedAt,
          submittedAt: activeAttempt.submittedAt,
          durationSpent: activeAttempt.durationSpent,
        };
      }

      const max = exam.maxAttempts ?? 1;
      canRetake = Boolean(inProgressAttempt || max === 0 || attemptCount < max);
    }

    res.json({
      id: exam.id,
      chapterId: exam.chapterId,
      chapterTitle: exam.chapter?.title || '',
      chapterCode: exam.chapter?.code || '',
      gradeLevel: exam.chapter?.grade?.code || '',
      title: exam.title,
      description: exam.description || '',
      duration: exam.duration,
      isPublic: exam.isPublic,
      maxAttempts: exam.maxAttempts ?? 1,
      attemptCount,
      canRetake,
      myAttempt,
      assignedClasses: exam.assignments.map((a) => ({
        id: a.studentClass.id,
        name: a.studentClass.name,
      })),
      questions,
    });
  } catch (error) {
    console.error('Get chapter exam error:', error);
    res.status(500).json({ error: 'Lỗi khi tải chi tiết bài kiểm tra' });
  }
});

// ----------------------------------------------------
// 3. POST /api/chapter-exams - Tạo bài kiểm tra chương mới (Giáo viên)
// ----------------------------------------------------
router.post('/', authenticate, requireRole('TEACHER'), async (req, res) => {
  try {
    const {
      chapterId,
      gradeLevel,
      chapterTitle,
      chapterCode,
      title,
      description,
      duration,
      isPublic,
      maxAttempts,
      classIds,
      questions,
    } = req.body;

    const normalizedTitle = normalizeText(title);
    if (!normalizedTitle) {
      return res.status(400).json({ error: 'Tiêu đề bài kiểm tra là bắt buộc' });
    }

    let finalChapterId = parseOptionalInt(chapterId);

    // If chapterId not provided, find or create chapter
    if (!finalChapterId) {
      const gCode = ['10', '11', '12'].includes(String(gradeLevel)) ? String(gradeLevel) : '12';
      const grade = await ensureGrade(prisma, gCode);
      const cTitle = normalizeText(chapterTitle, 'Chương mới');
      const cCode = normalizeText(chapterCode) || `chuong-${Date.now()}`;

      const chapter = await prisma.chapter.upsert({
        where: { gradeId_code: { gradeId: grade.id, code: cCode } },
        update: { title: cTitle },
        create: { gradeId: grade.id, code: cCode, title: cTitle },
      });
      finalChapterId = chapter.id;
    }

    const examDuration = Math.max(0, parseInt(duration, 10) || 45);
    const examIsPublic = isPublic === undefined ? true : Boolean(isPublic);
    const examMaxAttempts = maxAttempts !== undefined ? Math.max(0, parseInt(maxAttempts, 10) || 0) : 1;

    // Validate questions
    const validQuestions = Array.isArray(questions) ? questions : [];
    if (validQuestions.length === 0) {
      return res.status(400).json({ error: 'Bài kiểm tra cần có ít nhất 1 câu hỏi' });
    }

    for (let i = 0; i < validQuestions.length; i++) {
      const q = validQuestions[i];
      if (!q.content || !normalizeText(q.content)) {
        return res.status(400).json({ error: `Câu hỏi số ${i + 1} chưa có nội dung` });
      }
      if (!Array.isArray(q.options) || q.options.length < 2) {
        return res.status(400).json({ error: `Câu hỏi số ${i + 1} phải có ít nhất 2 phương án lựa chọn` });
      }
      if (!['A', 'B', 'C', 'D'].includes(String(q.correctAnswer).toUpperCase())) {
        return res.status(400).json({ error: `Câu hỏi số ${i + 1} phải có đáp án đúng là A, B, C hoặc D` });
      }
    }

    const createdExam = await prisma.$transaction(async (tx) => {
      const exam = await tx.chapterExam.create({
        data: {
          chapterId: finalChapterId,
          title: normalizedTitle,
          description: normalizeText(description),
          duration: examDuration,
          isPublic: examIsPublic,
          maxAttempts: examMaxAttempts,
        },
      });

      // Insert questions (10 điểm chia đều cho số câu)
      const pointPerQuestion = parseFloat((10 / validQuestions.length).toFixed(4));
      for (let i = 0; i < validQuestions.length; i++) {
        const q = validQuestions[i];
        await tx.chapterQuestion.create({
          data: {
            chapterExamId: exam.id,
            content: normalizeText(q.content),
            image: q.image || null,
            options: q.options,
            optionImages: Array.isArray(q.optionImages) ? q.optionImages : null,
            correctAnswer: String(q.correctAnswer).toUpperCase(),
            explanation: normalizeText(q.explanation),
            explanationImage: q.explanationImage || null,
            points: pointPerQuestion,
            order: i,
          },
        });
      }

      // Assign classes
      if (Array.isArray(classIds) && classIds.length > 0) {
        for (const cId of classIds) {
          const parsedCId = parseInt(cId, 10);
          if (!Number.isNaN(parsedCId)) {
            await tx.chapterExamAssignment.create({
              data: {
                chapterExamId: exam.id,
                classId: parsedCId,
              },
            });
          }
        }
      }

      return exam;
    });

    res.status(201).json({ id: createdExam.id, message: 'Tạo bài kiểm tra chương thành công' });
  } catch (error) {
    console.error('Create chapter exam error:', error);
    res.status(500).json({ error: 'Không thể tạo bài kiểm tra chương' });
  }
});

// ----------------------------------------------------
// 4. PUT /api/chapter-exams/:id - Cập nhật bài kiểm tra chương (Giáo viên)
// ----------------------------------------------------
router.put('/:id', authenticate, requireRole('TEACHER'), async (req, res) => {
  try {
    const examId = parseInt(req.params.id, 10);
    if (Number.isNaN(examId)) return res.status(400).json({ error: 'Mã bài kiểm tra không hợp lệ' });

    const {
      title,
      description,
      duration,
      isPublic,
      maxAttempts,
      chapterId,
      classIds,
      questions,
    } = req.body;

    const existing = await prisma.chapterExam.findUnique({
      where: { id: examId, deletedAt: null },
    });
    if (!existing) return res.status(404).json({ error: 'Không tìm thấy bài kiểm tra' });

    if (questions !== undefined) {
      if (!Array.isArray(questions) || questions.length === 0) {
        return res.status(400).json({ error: 'Bài kiểm tra cần có ít nhất 1 câu hỏi' });
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.chapterExam.update({
        where: { id: examId },
        data: {
          title: normalizeText(title, existing.title),
          description: description !== undefined ? normalizeText(description) : existing.description,
          duration: duration !== undefined ? Math.max(0, parseInt(duration, 10) || 45) : existing.duration,
          isPublic: isPublic !== undefined ? Boolean(isPublic) : existing.isPublic,
          ...(maxAttempts !== undefined ? { maxAttempts: Math.max(0, parseInt(maxAttempts, 10) || 0) } : {}),
          ...(chapterId ? { chapterId: parseInt(chapterId, 10) } : {}),
        },
      });

      // Replace questions if provided (10 điểm chia đều cho số câu)
      if (Array.isArray(questions)) {
        await tx.chapterQuestion.deleteMany({ where: { chapterExamId: examId } });
        const pointPerQuestion = parseFloat((10 / questions.length).toFixed(4));
        for (let i = 0; i < questions.length; i++) {
          const q = questions[i];
          await tx.chapterQuestion.create({
            data: {
              chapterExamId: examId,
              content: normalizeText(q.content),
              image: q.image || null,
              options: q.options,
              optionImages: Array.isArray(q.optionImages) ? q.optionImages : null,
              correctAnswer: String(q.correctAnswer).toUpperCase(),
              explanation: normalizeText(q.explanation),
              explanationImage: q.explanationImage || null,
              points: pointPerQuestion,
              order: i,
            },
          });
        }
      }

      // Update assignments
      if (Array.isArray(classIds)) {
        await tx.chapterExamAssignment.deleteMany({ where: { chapterExamId: examId } });
        for (const cId of classIds) {
          const parsedCId = parseInt(cId, 10);
          if (!Number.isNaN(parsedCId)) {
            await tx.chapterExamAssignment.create({
              data: {
                chapterExamId: examId,
                classId: parsedCId,
              },
            });
          }
        }
      }
    });

    res.json({ ok: true, message: 'Đã cập nhật bài kiểm tra chương' });
  } catch (error) {
    console.error('Update chapter exam error:', error);
    res.status(500).json({ error: 'Không thể cập nhật bài kiểm tra chương' });
  }
});

// ----------------------------------------------------
// 5. DELETE /api/chapter-exams/:id - Xoá bài kiểm tra chương (Giáo viên)
// ----------------------------------------------------
router.delete('/:id', authenticate, requireRole('TEACHER'), async (req, res) => {
  try {
    const examId = parseInt(req.params.id, 10);
    if (Number.isNaN(examId)) return res.status(400).json({ error: 'Mã bài kiểm tra không hợp lệ' });

    await prisma.chapterExam.update({
      where: { id: examId },
      data: { deletedAt: new Date() },
    });

    res.json({ ok: true, message: 'Đã xoá bài kiểm tra chương' });
  } catch (error) {
    console.error('Delete chapter exam error:', error);
    res.status(500).json({ error: 'Không thể xoá bài kiểm tra chương' });
  }
});

// ----------------------------------------------------
// 6. POST /api/chapter-exams/:id/start - Học sinh bắt đầu làm bài kiểm tra
// ----------------------------------------------------
router.post('/:id/start', authenticate, async (req, res) => {
  try {
    const examId = parseInt(req.params.id, 10);
    const userId = req.user.id;

    if (Number.isNaN(examId)) return res.status(400).json({ error: 'Mã bài kiểm tra không hợp lệ' });

    const exam = await prisma.chapterExam.findFirst({
      where: { id: examId, deletedAt: null },
      include: {
        chapter: { include: { grade: true } },
        questions: { orderBy: { order: 'asc' } },
      },
    });
    if (!exam) return res.status(404).json({ error: 'Không tìm thấy bài kiểm tra' });

    // Check if there is an in-progress attempt
    let attempt = await prisma.chapterExamAttempt.findFirst({
      where: { userId, chapterExamId: examId, isComplete: false },
      include: { answers: true },
    });

    const completedCount = await prisma.chapterExamAttempt.count({
      where: { userId, chapterExamId: examId, isComplete: true },
    });

    const max = exam.maxAttempts ?? 1;

    if (!attempt) {
      if (max > 0 && completedCount >= max) {
        return res.status(400).json({
          error: `Bạn đã hoàn thành đủ số lượt làm bài (${completedCount}/${max} lượt). Không thể làm lại bài kiểm tra này nữa.`,
        });
      }

      // Calculate total points
      const totalPoints = exam.questions.reduce((sum, q) => sum + (q.points || 1), 0);

      attempt = await prisma.chapterExamAttempt.create({
        data: {
          userId,
          chapterExamId: examId,
          totalPoints,
          totalCount: exam.questions.length,
          score: 0,
          outCount: 0,
          isComplete: false,
          startedAt: new Date(),
        },
        include: { answers: true },
      });
    }

    const attemptNumber = completedCount + 1;

    const formattedQuestions = exam.questions.map((q) => {
      const savedAnswer = attempt.answers.find((a) => a.questionId === q.id);
      return {
        id: q.id,
        content: q.content,
        image: q.image,
        options: q.options,
        optionImages: q.optionImages,
        points: q.points,
        order: q.order,
        selectedAnswer: savedAnswer?.selected || null,
      };
    });

    res.json({
      attemptId: attempt.id,
      startedAt: attempt.startedAt,
      serverNow: new Date().toISOString(),
      outCount: attempt.outCount,
      duration: exam.duration,
      durationSpent: attempt.durationSpent,
      title: exam.title,
      chapterTitle: exam.chapter.title,
      maxAttempts: max,
      attemptNumber,
      questions: formattedQuestions,
    });
  } catch (error) {
    console.error('Start chapter exam error:', error);
    res.status(500).json({ error: 'Không thể bắt đầu làm bài' });
  }
});

// ----------------------------------------------------
// 7. POST /api/chapter-exams/attempt/:attemptId/log-out - GHI NHẬN SỐ LẦN OUT RA NGOÀI CỦA HỌC SINH
// ----------------------------------------------------
router.post('/attempt/:attemptId/log-out', authenticate, async (req, res) => {
  try {
    const attemptId = parseInt(req.params.attemptId, 10);
    const userId = req.user.id;
    const { durationSpent } = req.body;

    if (Number.isNaN(attemptId)) return res.status(400).json({ error: 'attemptId không hợp lệ' });

    const attempt = await prisma.chapterExamAttempt.findFirst({
      where: { id: attemptId, userId, isComplete: false },
    });
    if (!attempt) return res.status(404).json({ error: 'Lượt làm bài không hợp lệ hoặc đã kết thúc' });

    const updated = await prisma.chapterExamAttempt.update({
      where: { id: attemptId },
      data: {
        outCount: { increment: 1 },
        ...(durationSpent !== undefined ? { durationSpent: parseInt(durationSpent, 10) || attempt.durationSpent } : {}),
      },
      select: { id: true, outCount: true },
    });

    res.json({
      ok: true,
      outCount: updated.outCount,
      message: `Đã ghi nhận học sinh rời màn hình lần thứ ${updated.outCount}`,
    });
  } catch (error) {
    console.error('Log out event error:', error);
    res.status(500).json({ error: 'Không thể ghi nhận vi phạm' });
  }
});

// ----------------------------------------------------
// 8. POST /api/chapter-exams/attempt/:attemptId/save-answers - Lưu câu trả lời khi đang làm
// ----------------------------------------------------
router.post('/attempt/:attemptId/save-answers', authenticate, async (req, res) => {
  try {
    const attemptId = parseInt(req.params.attemptId, 10);
    const userId = req.user.id;
    const { answers, durationSpent } = req.body; // array of { questionId, selected }

    if (Number.isNaN(attemptId)) return res.status(400).json({ error: 'attemptId không hợp lệ' });

    const attempt = await prisma.chapterExamAttempt.findFirst({
      where: { id: attemptId, userId, isComplete: false },
    });
    if (!attempt) return res.status(404).json({ error: 'Lượt làm không hợp lệ' });

    if (durationSpent !== undefined) {
      await prisma.chapterExamAttempt.update({
        where: { id: attemptId },
        data: { durationSpent: parseInt(durationSpent, 10) || 0 },
      });
    }

    if (Array.isArray(answers) && answers.length > 0) {
      for (const item of answers) {
        const qId = parseInt(item.questionId, 10);
        if (Number.isNaN(qId)) continue;

        await prisma.chapterStudentAnswer.upsert({
          where: { attemptId_questionId: { attemptId, questionId: qId } },
          update: {
            selected: item.selected ? String(item.selected).toUpperCase() : null,
            answeredAt: new Date(),
          },
          create: {
            attemptId,
            questionId: qId,
            selected: item.selected ? String(item.selected).toUpperCase() : null,
          },
        });
      }
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('Save answers error:', error);
    res.status(500).json({ error: 'Không thể lưu câu trả lời' });
  }
});

// ----------------------------------------------------
// 9. POST /api/chapter-exams/attempt/:attemptId/submit - Nộp bài kiểm tra chương
// ----------------------------------------------------
router.post('/attempt/:attemptId/submit', authenticate, async (req, res) => {
  try {
    const attemptId = parseInt(req.params.attemptId, 10);
    const userId = req.user.id;
    const { answers, durationSpent, finalOutCount } = req.body;

    const attempt = await prisma.chapterExamAttempt.findFirst({
      where: { id: attemptId, userId, isComplete: false },
      include: {
        chapterExam: {
          include: { questions: true },
        },
      },
    });
    if (!attempt) return res.status(404).json({ error: 'Lượt làm không tồn tại hoặc đã nộp bài rồi' });

    const questions = attempt.chapterExam.questions;
    const questionsById = Object.fromEntries(questions.map((q) => [q.id, q]));

    // Update answers from payload
    if (Array.isArray(answers) && answers.length > 0) {
      for (const item of answers) {
        const qId = parseInt(item.questionId, 10);
        if (Number.isNaN(qId)) continue;
        const q = questionsById[qId];
        const selected = item.selected ? String(item.selected).toUpperCase() : null;
        const isCorrect = selected && q ? selected === q.correctAnswer : false;

        await prisma.chapterStudentAnswer.upsert({
          where: { attemptId_questionId: { attemptId, questionId: qId } },
          update: { selected, isCorrect, answeredAt: new Date() },
          create: { attemptId, questionId: qId, selected, isCorrect },
        });
      }
    }

    // Read all student answers for this attempt
    const studentAnswers = await prisma.chapterStudentAnswer.findMany({
      where: { attemptId },
    });

    let correctCount = 0;

    for (const q of questions) {
      const ans = studentAnswers.find((a) => a.questionId === q.id);
      const isCorrect = ans?.selected === q.correctAnswer;
      if (isCorrect) {
        correctCount++;
      }
      // Make sure DB reflects correct status
      if (ans && ans.isCorrect !== isCorrect) {
        await prisma.chapterStudentAnswer.update({
          where: { id: ans.id },
          data: { isCorrect },
        });
      }
    }

    // 10 điểm chia đều ra số câu (Thang điểm 10 chuẩn)
    const totalCount = questions.length;
    const rawScore = totalCount > 0 ? (correctCount / totalCount) * 10 : 0;
    const finalScore = parseFloat(rawScore.toFixed(2));
    const totalPoints = 10;

    const totalOut = finalOutCount !== undefined
      ? Math.max(attempt.outCount, parseInt(finalOutCount, 10) || 0)
      : attempt.outCount;

    const updated = await prisma.chapterExamAttempt.update({
      where: { id: attemptId },
      data: {
        score: finalScore,
        correctCount,
        totalCount: questions.length,
        totalPoints,
        isComplete: true,
        submittedAt: new Date(),
        durationSpent: parseInt(durationSpent, 10) || attempt.durationSpent,
        outCount: totalOut,
      },
    });

    res.json({
      attemptId: updated.id,
      score: updated.score,
      correctCount: updated.correctCount,
      totalCount: updated.totalCount,
      outCount: updated.outCount,
      durationSpent: updated.durationSpent,
      submittedAt: updated.submittedAt,
    });
  } catch (error) {
    console.error('Submit chapter exam error:', error);
    res.status(500).json({ error: 'Nộp bài thất bại' });
  }
});

// ----------------------------------------------------
// 10. GET /api/chapter-exams/attempt/:attemptId/review - Xem lại kết quả bài thi
// ----------------------------------------------------
router.get('/attempt/:attemptId/review', authenticate, async (req, res) => {
  try {
    const attemptId = parseInt(req.params.attemptId, 10);
    const userId = req.user.id;
    const role = req.user.role;

    const where = { id: attemptId };
    if (role === 'STUDENT') {
      where.userId = userId;
    }

    const attempt = await prisma.chapterExamAttempt.findFirst({
      where,
      include: {
        user: { select: { id: true, fullName: true, username: true } },
        chapterExam: {
          include: {
            chapter: { include: { grade: true } },
            questions: { orderBy: { order: 'asc' } },
          },
        },
        answers: true,
      },
    });

    if (!attempt) return res.status(404).json({ error: 'Không tìm thấy kết quả bài thi' });

    const questionsReview = attempt.chapterExam.questions.map((q) => {
      const studentAns = attempt.answers.find((a) => a.questionId === q.id);
      return {
        id: q.id,
        content: q.content,
        image: q.image,
        options: q.options,
        optionImages: q.optionImages,
        points: q.points,
        order: q.order,
        correctAnswer: q.correctAnswer,
        explanation: q.explanation || '',
        explanationImage: q.explanationImage || null,
        studentSelected: studentAns?.selected || null,
        isCorrect: Boolean(studentAns?.isCorrect),
      };
    });

    res.json({
      attemptId: attempt.id,
      examId: attempt.chapterExamId,
      examTitle: attempt.chapterExam.title,
      chapterTitle: attempt.chapterExam.chapter?.title || '',
      gradeLevel: attempt.chapterExam.chapter?.grade?.code || '',
      score: attempt.score,
      correctCount: attempt.correctCount,
      totalCount: attempt.totalCount,
      outCount: attempt.outCount,
      durationSpent: attempt.durationSpent,
      startedAt: attempt.startedAt,
      submittedAt: attempt.submittedAt,
      studentName: attempt.user.fullName,
      questions: questionsReview,
    });
  } catch (error) {
    console.error('Review chapter exam attempt error:', error);
    res.status(500).json({ error: 'Không thể xem lại kết quả' });
  }
});

// ----------------------------------------------------
// 11. GET /api/chapter-exams/:id/results - GIÁO VIÊN XEM ĐIỂM VÀ SỐ LẦN OUT RA CỦA HỌC SINH
// ----------------------------------------------------
router.get('/:id/results', authenticate, requireRole('TEACHER'), async (req, res) => {
  try {
    const examId = parseInt(req.params.id, 10);
    const { classId } = req.query;

    if (Number.isNaN(examId)) return res.status(400).json({ error: 'Mã bài kiểm tra không hợp lệ' });

    const exam = await prisma.chapterExam.findUnique({
      where: { id: examId, deletedAt: null },
      include: {
        chapter: { include: { grade: true } },
        assignments: {
          include: {
            studentClass: { include: { school: true, grade: true, academicYear: true } },
          },
        },
        questions: { select: { id: true, points: true } },
      },
    });

    if (!exam) return res.status(404).json({ error: 'Không tìm thấy bài kiểm tra' });

    // 1. Lấy tất cả lượt làm bài cho đề này (kèm thông tin học sinh và lớp, sắp xếp theo thời gian bắt đầu)
    const attempts = await prisma.chapterExamAttempt.findMany({
      where: { chapterExamId: examId },
      include: {
        user: {
          include: {
            studentClass: {
              include: { school: true, grade: true, academicYear: true },
            },
          },
        },
      },
      orderBy: { startedAt: 'asc' },
    });

    // 2. Xác định danh sách học sinh thuộc đối tượng dự thi (theo lớp/khối)
    const targetStudentWhere = { role: 'STUDENT', deletedAt: null };
    if (classId && classId !== 'ALL' && !Number.isNaN(parseInt(classId, 10))) {
      targetStudentWhere.classId = parseInt(classId, 10);
    } else if (!exam.isPublic && exam.assignments.length > 0) {
      targetStudentWhere.classId = { in: exam.assignments.map((a) => a.classId) };
    } else {
      targetStudentWhere.studentClass = { gradeId: exam.chapter.gradeId };
    }

    const assignedStudents = await prisma.user.findMany({
      where: targetStudentWhere,
      include: {
        studentClass: {
          include: { school: true, grade: true, academicYear: true },
        },
      },
      orderBy: [{ studentClass: { name: 'asc' } }, { fullName: 'asc' }],
    });

    // 3. Kết hợp: Học sinh thuộc đối tượng + BẤT KỲ AI ĐÃ LÀM BÀI (kể cả học sinh lớp khác hoặc khối khác)
    const allUsersMap = new Map();
    for (const s of assignedStudents) {
      allUsersMap.set(s.id, s);
    }
    for (const a of attempts) {
      if (a.user && a.user.role === 'STUDENT' && !allUsersMap.has(a.userId)) {
        if (classId && classId !== 'ALL' && !Number.isNaN(parseInt(classId, 10))) {
          if (a.user.classId === parseInt(classId, 10)) {
            allUsersMap.set(a.userId, a.user);
          }
        } else {
          allUsersMap.set(a.userId, a.user);
        }
      }
    }

    const students = Array.from(allUsersMap.values()).sort((a, b) => {
      const clsA = a.studentClass?.name || '';
      const clsB = b.studentClass?.name || '';
      return clsA.localeCompare(clsB, 'vi') || (a.fullName || '').localeCompare(b.fullName || '', 'vi');
    });

    // Match each student with their latest attempt
    let totalScoreSum = 0;
    let completedCount = 0;
    let highestScore = null;
    let lowestScore = null;
    let outViolationCount = 0; // Số học sinh có outCount > 0

    // Phân loại mức độ vi phạm out tab
    let cleanCount = 0;       // 0 lần
    let warningCount = 0;     // 1 - 2 lần
    let highRiskCount = 0;    // >= 3 lần

    const rawRows = students.map((s) => {
      // Các lượt làm của học sinh này (theo thứ tự bắt đầu từ cũ đến mới: Lần 1, Lần 2...)
      const userAttempts = attempts
        .filter((a) => a.userId === s.id)
        .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));

      const completedUserAttempts = userAttempts.filter((a) => a.isComplete);
      const inProgressAttempt = userAttempts.find((a) => !a.isComplete);

      // Điểm cao nhất trong các lần hoàn thành (Best Score) hoặc lượt đang làm
      const bestAttempt = completedUserAttempts.length > 0
        ? [...completedUserAttempts].sort((a, b) => (b.score || 0) - (a.score || 0))[0]
        : null;

      const studentAttempt = bestAttempt || inProgressAttempt || null;

      const isCompleted = studentAttempt?.isComplete ?? false;
      const isInProgress = studentAttempt && !studentAttempt.isComplete;
      const status = isCompleted ? 'COMPLETED' : isInProgress ? 'IN_PROGRESS' : 'NOT_STARTED';

      const score = isCompleted ? studentAttempt.score : null;
      const attemptCount = completedUserAttempts.length;

      // Danh sách chi tiết từng lần làm bài
      const attemptList = userAttempts.map((a, idx) => ({
        attemptNumber: idx + 1,
        id: a.id,
        score: a.isComplete ? a.score : null,
        correctCount: a.isComplete ? a.correctCount : null,
        totalCount: a.totalCount || exam.questions.length,
        outCount: a.outCount || 0,
        durationSpent: a.durationSpent || 0,
        isComplete: a.isComplete,
        startedAt: a.startedAt,
        submittedAt: a.submittedAt,
      }));

      // GIÁM SÁT TOÀN DIỆN QUA TẤT CẢ CÁC LẦN THI CỦA HỌC SINH
      const totalOutCount = userAttempts.reduce((sum, a) => sum + (a.outCount || 0), 0);
      const maxOutCount = userAttempts.length > 0 ? Math.max(...userAttempts.map((a) => a.outCount || 0)) : 0;
      const hasOutViolation = userAttempts.some((a) => (a.outCount || 0) > 0);

      if (isCompleted && score !== null) {
        completedCount++;
        totalScoreSum += score;
        if (highestScore === null || score > highestScore) highestScore = score;
        if (lowestScore === null || score < lowestScore) lowestScore = score;
      }

      let riskTier = 'AN_TOAN';
      if (status !== 'NOT_STARTED') {
        if (maxOutCount >= 3) {
          outViolationCount++;
          highRiskCount++;
          riskTier = 'NGHI_VAN_CAO';
        } else if (hasOutViolation) {
          outViolationCount++;
          warningCount++;
          riskTier = 'CANH_BAO';
        } else {
          cleanCount++;
          riskTier = 'AN_TOAN';
        }
      }

      return {
        studentId: s.id,
        fullName: s.fullName,
        username: s.username,
        classId: s.studentClass?.id ?? null,
        className: s.studentClass?.name ?? 'Chưa gán lớp',
        school: s.studentClass?.school?.name ?? '',
        status,
        attemptId: studentAttempt?.id ?? null,
        bestAttemptId: bestAttempt?.id ?? null,
        score,
        riskTier,
        correctCount: studentAttempt?.correctCount ?? null,
        totalCount: studentAttempt?.totalCount ?? exam.questions.length,
        outCount: totalOutCount, // Tổng số lần rời màn hình qua tất cả lần thi
        maxOutCount,             // Lần rời màn hình nhiều nhất ở 1 bài thi
        hasOutViolation,
        attempts: attemptList,   // Chi tiết từng lần làm
        attemptCount,
        maxAttempts: exam.maxAttempts ?? 1,
        startedAt: studentAttempt?.startedAt ?? null,
        submittedAt: studentAttempt?.submittedAt ?? null,
        durationSpent: studentAttempt?.durationSpent ?? 0,
      };
    });

    // Thêm xếp hạng (Rank) cho học sinh đã hoàn thành
    const sortedCompleted = [...rawRows.filter((r) => r.status === 'COMPLETED')]
      .sort((a, b) => (b.score || 0) - (a.score || 0));
    const rankMap = new Map();
    sortedCompleted.forEach((r, idx) => {
      rankMap.set(r.studentId, idx + 1);
    });

    const rows = rawRows.map((r, index) => ({
      ...r,
      stt: index + 1,
      rank: rankMap.get(r.studentId) ?? null,
    }));

    // Phổ điểm chi tiết theo độ chia nhỏ nhất (Tần số từng mức điểm)
    const scoreFrequencyMap = new Map();
    for (const r of rows) {
      if (r.status === 'COMPLETED' && r.score !== null) {
        const sc = parseFloat(r.score.toFixed(2));
        if (!scoreFrequencyMap.has(sc)) {
          scoreFrequencyMap.set(sc, { count: 0, students: [] });
        }
        const item = scoreFrequencyMap.get(sc);
        item.count += 1;
        item.students.push(r.fullName);
      }
    }

    // Xác định độ chia nhỏ nhất (min step) dựa trên số câu hỏi
    const numQ = exam.questions.length || 1;
    const scoreStep = parseFloat((10 / numQ).toFixed(2));

    // Tạo danh sách tất cả các mốc điểm có thể có từ 10 xuống 0
    const possibleScores = [];
    for (let i = numQ; i >= 0; i--) {
      const s = parseFloat(((i / numQ) * 10).toFixed(2));
      possibleScores.push(s);
    }

    const scoreDistribution = possibleScores.map((scoreVal) => {
      const dataItem = scoreFrequencyMap.get(scoreVal) || { count: 0, students: [] };
      return {
        score: scoreVal,
        count: dataItem.count,
        percentage: completedCount > 0 ? Math.round((dataItem.count / completedCount) * 100) : 0,
        students: dataItem.students,
      };
    });

    // Thống kê số lần làm bài (Bao nhiêu HS làm 1 lần, 2 lần...)
    const attemptDistribution = {};
    for (const r of rows) {
      if (r.status === 'COMPLETED' && r.attemptCount > 0) {
        attemptDistribution[r.attemptCount] = (attemptDistribution[r.attemptCount] || 0) + 1;
      }
    }

    // Thống kê giám sát vi phạm theo từng lần thi (Lần 1, Lần 2...)
    const violationByAttemptMap = new Map();
    for (const s of students) {
      const uAttempts = attempts
        .filter((a) => a.userId === s.id)
        .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
      uAttempts.forEach((a, idx) => {
        const attNum = idx + 1;
        if (!violationByAttemptMap.has(attNum)) {
          violationByAttemptMap.set(attNum, {
            attemptNumber: attNum,
            totalAttempts: 0,
            studentsWithViolation: 0,
            totalOuts: 0,
          });
        }
        const stat = violationByAttemptMap.get(attNum);
        stat.totalAttempts += 1;
        if ((a.outCount || 0) > 0) {
          stat.studentsWithViolation += 1;
          stat.totalOuts += a.outCount;
        }
      });
    }
    const violationByAttempt = Array.from(violationByAttemptMap.values()).sort(
      (a, b) => a.attemptNumber - b.attemptNumber
    );

    // Danh sách các lớp cho dropdown lọc (gồm các lớp thuộc khối + lớp của học sinh đã làm bài)
    const attemptedClassIds = attempts.map((a) => a.user?.classId).filter(Boolean);
    const availableClasses = await prisma.studentClass.findMany({
      where: {
        OR: [
          { gradeId: exam.chapter.gradeId },
          { id: { in: attemptedClassIds } },
        ],
      },
      include: { school: true, academicYear: true },
      orderBy: { name: 'asc' },
    });

    res.json({
      exam: {
        id: exam.id,
        title: exam.title,
        chapterTitle: exam.chapter?.title || '',
        chapterCode: exam.chapter?.code || '',
        gradeLevel: exam.chapter?.grade?.code || '',
        duration: exam.duration,
        maxAttempts: exam.maxAttempts ?? 1,
        questionCount: exam.questions.length,
        scoreStep,
      },
      stats: {
        totalStudents: students.length,
        completedCount,
        inProgressCount: rows.filter((r) => r.status === 'IN_PROGRESS').length,
        notStartedCount: rows.filter((r) => r.status === 'NOT_STARTED').length,
        avgScore: completedCount > 0 ? parseFloat((totalScoreSum / completedCount).toFixed(2)) : null,
        highestScore,
        lowestScore,
        outViolationCount, // Số học sinh out tab
        scoreStep,
        scoreDistribution,
        attemptDistribution,
        violationByAttempt,
        // Mức độ tuân thủ quy chế thi (Rời màn hình)
        riskDistribution: {
          cleanCount,       // 0 lần (nghiêm túc)
          warningCount,     // 1 - 2 lần
          highRiskCount,    // >= 3 lần (nguy cơ gian lận cao)
        },
      },
      classes: availableClasses.map((c) => ({
        id: c.id,
        name: c.name,
        school: c.school.name,
      })),
      rows,
    });
  } catch (error) {
    console.error('Get chapter exam results error:', error);
    res.status(500).json({ error: 'Không thể tải kết quả kiểm tra chương' });
  }
});

module.exports = router;
