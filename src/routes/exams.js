const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// POST /api/exams — tạo bài tập kèm cây node
router.post('/', authenticate, requireRole('TEACHER'), async (req, res) => {
  try {
    const { title, nodes } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Tiêu đề bài tập là bắt buộc' });
    }
    if (!Array.isArray(nodes) || nodes.length === 0) {
      return res.status(400).json({ error: 'Cần ít nhất một node' });
    }

    const exam = await prisma.exam.create({ data: { title: title.trim() } });

    // Tạo map từ tempId -> node để tra cứu nhanh
    const nodesById = {};
    nodes.forEach((n) => {
      nodesById[n.tempId] = n;
    });

    // Tìm root (không có parentTempId)
    const roots = nodes.filter((n) => !n.parentTempId);
    if (roots.length === 0) {
      await prisma.exam.delete({ where: { id: exam.id } });
      return res.status(400).json({ error: 'Không tìm thấy node gốc' });
    }

    // BFS để tạo node theo thứ tự cha trước con
    const idMap = {}; // tempId -> real DB id
    const queue = roots.map((r) => r.tempId);
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
          parentId: parentId ?? null,
          label: (node.label || '').trim(),
          question: (node.question || '').trim(),
          correctAnswer: (node.correctAnswer || '').trim(),
          hint: (node.hint || '').trim(),
          points: Math.max(1, parseInt(node.points) || 1),
          order: parseInt(node.order) || 0,
        },
      });

      idMap[tempId] = created.id;
      processed.add(tempId);

      // Thêm con vào queue
      const children = nodes.filter(
        (n) => n.parentTempId === tempId && !processed.has(n.tempId)
      );
      queue.push(...children.map((c) => c.tempId));
    }

    const fullExam = await prisma.exam.findUnique({
      where: { id: exam.id },
      include: { nodes: { orderBy: [{ parentId: 'asc' }, { order: 'asc' }] } },
    });

    res.status(201).json(fullExam);
  } catch (error) {
    console.error('Create exam error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/exams — danh sách bài tập
router.get('/', authenticate, async (req, res) => {
  try {
    const exams = await prisma.exam.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { nodes: true } } },
    });
    res.json(exams);
  } catch (error) {
    console.error('Get exams error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/exams/:id — chi tiết bài tập với cây node
router.get('/:id', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'ID không hợp lệ' });

    const exam = await prisma.exam.findUnique({
      where: { id },
      include: {
        nodes: { orderBy: [{ parentId: 'asc' }, { order: 'asc' }] },
      },
    });

    if (!exam) return res.status(404).json({ error: 'Không tìm thấy bài tập' });

    res.json(exam);
  } catch (error) {
    console.error('Get exam error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/exams/:id
router.delete('/:id', authenticate, requireRole('TEACHER'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'ID không hợp lệ' });

    await prisma.exam.delete({ where: { id } });
    res.json({ message: 'Đã xóa bài tập' });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Không tìm thấy bài tập' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
