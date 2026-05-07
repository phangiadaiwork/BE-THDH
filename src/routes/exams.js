const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const { PrismaClient } = require('@prisma/client');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();
const upload = multer({ storage: multer.memoryStorage() });

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

    const nodesById = {};
    nodes.forEach((n) => { nodesById[n.tempId] = n; });

    const roots = nodes.filter((n) => !n.parentTempId);
    if (roots.length === 0) {
      await prisma.exam.delete({ where: { id: exam.id } });
      return res.status(400).json({ error: 'Không tìm thấy node gốc' });
    }

    const idMap = {};
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
          options: node.options || null,
          correctAnswer: (node.correctAnswer || '').trim(),
          hint: (node.hint || '').trim(),
          points: Math.max(1, parseInt(node.points) || 1),
          order: parseInt(node.order) || 0,
        },
      });

      idMap[tempId] = created.id;
      processed.add(tempId);

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

// GET /api/exams/template — tải file Excel mẫu bài tập
router.get('/template', authenticate, requireRole('TEACHER'), (req, res) => {
  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.aoa_to_sheet([
    ['nodeId', 'parentNodeId', 'label', 'question', 'optionA', 'optionB', 'optionC', 'optionD', 'correctAnswer', 'hint', 'points'],
    ['1', '', 'Chủ đề chính', 'Câu hỏi gốc?', 'Đáp án A', 'Đáp án B', 'Đáp án C', 'Đáp án D', 'A', 'Gợi ý...', '1'],
    ['2', '1', 'Nhánh 1', 'Câu hỏi nhánh 1?', 'Đáp án A', 'Đáp án B', 'Đáp án C', 'Đáp án D', 'B', '', '2'],
    ['3', '1', 'Nhánh 2', 'Câu hỏi nhánh 2?', 'Đáp án A', 'Đáp án B', 'Đáp án C', 'Đáp án D', 'C', 'Gợi ý...', '1'],
    ['4', '2', 'Nhánh 1.1', 'Câu hỏi con?', 'Đáp án A', 'Đáp án B', 'Đáp án C', 'Đáp án D', 'D', '', '3'],
  ]);
  ws['!cols'] = [{ wch: 8 }, { wch: 12 }, { wch: 16 }, { wch: 30 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 20 }, { wch: 7 }];
  xlsx.utils.book_append_sheet(wb, ws, 'BaiTap');
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="mau_bai_tap.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// POST /api/exams/import — import bài tập từ Excel
router.post('/import', authenticate, requireRole('TEACHER'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Cần upload file Excel' });

    const { title } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'Cần tiêu đề bài tập' });

    const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(ws, { defval: '' });

    if (rows.length === 0) return res.status(400).json({ error: 'File không có dữ liệu' });

    const exam = await prisma.exam.create({ data: { title: title.trim() } });

    // Build nodes from rows
    const rowMap = {};
    rows.forEach((r) => {
      const nodeId = String(r.nodeId || '').trim();
      if (nodeId) rowMap[nodeId] = r;
    });

    const idMap = {};
    const ordersPerParent = {};

    // Process in order (assume rows are ordered parent-before-child)
    for (const r of rows) {
      const tempId = String(r.nodeId || '').trim();
      if (!tempId) continue;

      const parentTempId = String(r.parentNodeId || '').trim();
      const parentId = parentTempId ? (idMap[parentTempId] ?? null) : null;

      if (!ordersPerParent[parentTempId || 'root']) ordersPerParent[parentTempId || 'root'] = 0;
      const order = ordersPerParent[parentTempId || 'root']++;

      const optA = String(r.optionA || '').trim();
      const optB = String(r.optionB || '').trim();
      const optC = String(r.optionC || '').trim();
      const optD = String(r.optionD || '').trim();
      const hasOptions = optA || optB || optC || optD;
      const options = hasOptions
        ? [optA, optB, optC, optD].filter(Boolean).map((o, i) => `${['A', 'B', 'C', 'D'][i]}. ${o}`)
        : null;

      const created = await prisma.mindNode.create({
        data: {
          examId: exam.id,
          parentId,
          label: String(r.label || '').trim() || `Node ${tempId}`,
          question: String(r.question || '').trim(),
          options,
          correctAnswer: String(r.correctAnswer || '').trim(),
          hint: String(r.hint || '').trim(),
          points: Math.max(1, parseInt(r.points) || 1),
          order,
        },
      });
      idMap[tempId] = created.id;
    }

    const fullExam = await prisma.exam.findUnique({
      where: { id: exam.id },
      include: { nodes: { orderBy: [{ parentId: 'asc' }, { order: 'asc' }] }, _count: { select: { nodes: true } } },
    });

    res.status(201).json(fullExam);
  } catch (error) {
    console.error('Import exam error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/exams — danh sách bài tập (học sinh chỉ thấy bài được phân công)
router.get('/', authenticate, async (req, res) => {
  try {
    let where = {};

    if (req.user.role === 'STUDENT') {
      const userClass = req.user.className || '';
      where = {
        OR: [
          { isPublic: true },
          { visibleClasses: { has: userClass } },
        ],
      };
    }

    const exams = await prisma.exam.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { nodes: true } } },
    });
    res.json(exams);
  } catch (error) {
    console.error('Get exams error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/exams/:id — chi tiết bài tập
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

// PUT /api/exams/:id/visibility — cập nhật hiển thị bài tập theo lớp
router.put('/:id/visibility', authenticate, requireRole('TEACHER'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { isPublic, visibleClasses } = req.body;

    const data = {};
    if (isPublic !== undefined) data.isPublic = Boolean(isPublic);
    if (Array.isArray(visibleClasses)) data.visibleClasses = visibleClasses.map(String);

    const exam = await prisma.exam.update({
      where: { id },
      data,
      select: { id: true, title: true, isPublic: true, visibleClasses: true },
    });
    res.json(exam);
  } catch (error) {
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
