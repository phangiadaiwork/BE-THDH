const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { normalizeText } = require('./src/utils/education');

// Replicate normalizeNodeInput and validateNodes
function normalizeOptionValues(node) {
  if (Array.isArray(node.options)) return node.options;

  const rawOptions = ['optionA', 'optionB', 'optionC', 'optionD']
    .map((key) => normalizeText(node[key]))
    .filter(Boolean);

  return rawOptions.map((option, index) => `${['A', 'B', 'C', 'D'][index]}. ${option}`);
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
    order: parseInt(node.order) || index,
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
    
    const hasQText = node.question && node.question.replace(/<[^>]*>/g, '').trim() !== '';
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
      if (node.options.length < 2 || node.options.length > 4) {
        return `Node ${node.tempId} phải có từ 2 đến 4 phương án`;
      }
      if (!['A', 'B', 'C', 'D'].includes(node.correctAnswer)) {
        return `Node ${node.tempId} phải có đáp án đúng là A, B, C hoặc D`;
      }
      const optionLetters = node.options.map((option) => option.charAt(0));
      if (!optionLetters.includes(node.correctAnswer)) {
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

async function test() {
  const payload = {
    gradeLevel: '12',
    chapterTitle: 'Chương 1: Động học',
    chapterCode: 'chuong-1-dong-hoc',
    lessonTitle: 'Bài 1: Chuyển động thẳng đều test dummy ' + Date.now(),
    title: 'Bài 1: Chuyển động thẳng đều test dummy ' + Date.now(),
    exerciseTitle: 'Bài tập',
  };
  
  const nodes = [
    {
      tempId: 'node-1',
      parentTempId: null,
      label: 'Dummy Node',
      question: '',
      correctAnswer: '',
      options: [],
      optionImages: [null, null, null, null],
      points: 1,
      order: 0,
    }
  ];
  
  const normalizedNodes = nodes.map((n, i) => normalizeNodeInput(n, i));
  const err = validateNodes(normalizedNodes);
  console.log("Validation Error:", err);
  
  // Test DB creation logic
  try {
     const dbExam = await prisma.exam.findFirst();
     console.log("DB connection successful, found exam:", dbExam?.id);
  } catch (e) {
    console.error("DB Error:", e);
  } finally {
    await prisma.$disconnect();
  }
}
test();
