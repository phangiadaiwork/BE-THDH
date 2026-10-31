const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const { ensureDefaultAdmin } = require('../src/utils/ensureDefaultAdmin');
const {
  ensureAcademicYear,
  ensureGrade,
  ensureSchool,
  ensureStudentClass,
} = require('../src/utils/education');

const prisma = new PrismaClient();

const sampleLessons = [
  {
    gradeLevel: '12',
    chapterCode: 'chuong-vi',
    chapterTitle: 'Chương VI',
    chapterDisplayOrder: 6,
    lessonNumber: 18,
    lessonTitle: 'Lũy thừa với số mũ thực',
    theoryContent: 'Khái niệm lũy thừa với số mũ thực, các tính chất cơ bản của lũy thừa, cách biến đổi biểu thức và nhận diện điều kiện xác định.',
    exerciseTitle: 'Bài tập',
    nodes: [
      { tempId: '1', parentTempId: null, label: 'Lũy thừa', question: 'Lũy thừa a^(1/2) còn được hiểu là gì khi a > 0?', options: ['A. a + 2', 'B. Căn bậc hai của a', 'C. 2a', 'D. 1/a'], correctAnswer: 'B', hint: 'Liên hệ với căn bậc hai.', points: 1, order: 0 },
      { tempId: '2', parentTempId: '1', label: 'Tính chất 1', question: 'Với a > 0, a^m . a^n bằng gì?', options: ['A. a^(m+n)', 'B. a^(m-n)', 'C. a^(mn)', 'D. a^(m/n)'], correctAnswer: 'A', hint: 'Cùng cơ số thì cộng số mũ.', points: 1, order: 0 },
      { tempId: '3', parentTempId: '1', label: 'Tính chất 2', question: '(a^m)^n bằng gì?', options: ['A. a^(m+n)', 'B. a^(mn)', 'C. a^(m-n)', 'D. a^(m/n)'], correctAnswer: 'B', hint: 'Nhân hai số mũ.', points: 1, order: 1 },
    ],
  },
  {
    gradeLevel: '12',
    chapterCode: 'chuong-vi',
    chapterTitle: 'Chương VI',
    chapterDisplayOrder: 6,
    lessonNumber: 19,
    lessonTitle: 'Logarit',
    theoryContent: 'Định nghĩa logarit, điều kiện xác định, các công thức đổi cơ số và các tính chất của logarit giúp rút gọn biểu thức.',
    exerciseTitle: 'Bài tập',
    nodes: [
      { tempId: '1', parentTempId: null, label: 'Logarit', question: 'Điều kiện để log_a b xác định là gì?', options: ['A. a > 0, a != 1, b > 0', 'B. a > 1, b >= 0', 'C. a != 0, b > 0', 'D. a > 0, b != 1'], correctAnswer: 'A', hint: 'Nhớ đủ điều kiện của cơ số và số bị logarit.', points: 1, order: 0 },
      { tempId: '2', parentTempId: '1', label: 'Công thức', question: 'log_a(a^m) bằng gì?', options: ['A. a+m', 'B. am', 'C. m', 'D. 1/m'], correctAnswer: 'C', hint: 'Logarit và lũy thừa là hai phép toán ngược nhau.', points: 1, order: 0 },
      { tempId: '3', parentTempId: '1', label: 'Đổi cơ số', question: 'Công thức đổi cơ số đúng là?', options: ['A. log_a b = log_c a / log_c b', 'B. log_a b = log_c b / log_c a', 'C. log_a b = log_a c / log_b c', 'D. log_a b = log_b c / log_a c'], correctAnswer: 'B', hint: 'Chia log của số bị logarit cho log của cơ số.', points: 1, order: 1 },
    ],
  },
];

async function seedStudent(username, password, fullName, className, schoolName, academicYearName) {
  const studentClass = await ensureStudentClass(prisma, className, schoolName, academicYearName);
  const hashedPassword = await bcrypt.hash(password, 10);

  await prisma.user.upsert({
    where: { username },
    update: {
      password: hashedPassword,
      fullName,
      role: 'STUDENT',
      classId: studentClass.id,
    },
    create: {
      username,
      password: hashedPassword,
      fullName,
      role: 'STUDENT',
      classId: studentClass.id,
    },
  });
}

async function seedLessonExam(item) {
  const grade = await ensureGrade(prisma, item.gradeLevel);

  const chapter = await prisma.chapter.upsert({
    where: { gradeId_code: { gradeId: grade.id, code: item.chapterCode } },
    update: {
      title: item.chapterTitle,
      displayOrder: item.chapterDisplayOrder,
    },
    create: {
      gradeId: grade.id,
      code: item.chapterCode,
      title: item.chapterTitle,
      displayOrder: item.chapterDisplayOrder,
    },
  });

  const lesson = await prisma.lesson.upsert({
    where: { chapterId_title: { chapterId: chapter.id, title: item.lessonTitle } },
    update: {
      number: item.lessonNumber,
      theoryContent: item.theoryContent,
      displayOrder: item.lessonNumber,
    },
    create: {
      chapterId: chapter.id,
      number: item.lessonNumber,
      title: item.lessonTitle,
      theoryContent: item.theoryContent,
      displayOrder: item.lessonNumber,
    },
  });

  let exam = await prisma.exam.findUnique({
    where: { lessonId: lesson.id },
    include: { nodes: true },
  });

  if (!exam) {
    exam = await prisma.exam.create({
      data: {
        lessonId: lesson.id,
        title: item.lessonTitle,
        exerciseTitle: item.exerciseTitle,
        isPublic: true,
      },
      include: { nodes: true },
    });
  }

  if (exam.nodes.length > 0) return;

  const idMap = {};
  const queue = item.nodes.filter((node) => !node.parentTempId).map((node) => node.tempId);
  const nodesById = Object.fromEntries(item.nodes.map((node) => [node.tempId, node]));
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
        options: node.options,
        correctAnswer: node.correctAnswer,
        hint: node.hint,
        points: node.points,
        order: node.order,
      },
    });

    idMap[tempId] = created.id;
    processed.add(tempId);

    item.nodes
      .filter((child) => child.parentTempId === tempId && !processed.has(child.tempId))
      .forEach((child) => queue.push(child.tempId));
  }
}

async function seedSampleChapterExam() {
  const grade12 = await ensureGrade(prisma, '12');
  const chapter = await prisma.chapter.findFirst({
    where: { gradeId: grade12.id, code: 'chuong-vi' },
  });
  if (!chapter) return;

  const existing = await prisma.chapterExam.findFirst({
    where: { chapterId: chapter.id, title: 'Bài kiểm tra trắc nghiệm Chương VI: Lũy thừa và Logarit' },
  });
  if (existing) return;

  await prisma.chapterExam.create({
    data: {
      chapterId: chapter.id,
      title: 'Bài kiểm tra trắc nghiệm Chương VI: Lũy thừa và Logarit',
      description: 'Bài kiểm tra đánh giá kiến thức toàn chương VI: Lũy thừa với số mũ thực, hàm số lũy thừa, logarit và hàm số logarit. Hệ thống sẽ ghi nhận số lần chuyển tab / rời màn hình làm bài.',
      duration: 15,
      isPublic: true,
      questions: {
        create: [
          {
            content: 'Cho $a > 0, a \\ne 1$. Biểu thức $\\log_a(a^3)$ có giá trị bằng:',
            options: ['A. 1', 'B. 2', 'C. 3', 'D. a'],
            correctAnswer: 'C',
            explanation: 'Theo tính chất logarit: $\\log_a(a^x) = x$, do đó $\\log_a(a^3) = 3$.',
            points: 2,
            order: 0,
          },
          {
            content: 'Với $a, b > 0$ và $a \\ne 1$, khẳng định nào sau đây là khẳng định ĐÚNG?',
            options: [
              'A. $\\log_a(ab) = \\log_a a \\cdot \\log_a b$',
              'B. $\\log_a(ab) = \\log_a a + \\log_a b$',
              'C. $\\log_a(ab) = \\log_a a - \\log_a b$',
              'D. $\\log_a(ab) = \\frac{\\log_a a}{\\log_a b}$',
            ],
            correctAnswer: 'B',
            explanation: 'Logarit của một tích bằng tổng các logarit: $\\log_a(ab) = \\log_a a + \\log_a b$.',
            points: 2,
            order: 1,
          },
          {
            content: 'Tập xác định của hàm số $y = \\log_2(x - 3)$ là:',
            options: ['A. $(3; +\\infty)$', 'B. $[3; +\\infty)$', 'C. $(-\\infty; 3)$', 'D. $\\mathbb{R} \\setminus \\{3\\}$'],
            correctAnswer: 'A',
            explanation: 'Điều kiện xác định của biểu thức dưới dấu logarit: $x - 3 > 0 \\Leftrightarrow x > 3$. Do đó $D = (3; +\\infty)$.',
            points: 2,
            order: 2,
          },
          {
            content: 'Giá trị của biểu thức $P = 2^{\\log_2 8}$ bằng:',
            options: ['A. 2', 'B. 4', 'C. 8', 'D. 16'],
            correctAnswer: 'C',
            explanation: 'Theo đồng nhất thức logarit: $a^{\\log_a b} = b$ với $a > 0, a \\ne 1, b > 0$. Vậy $2^{\\log_2 8} = 8$.',
            points: 2,
            order: 3,
          },
          {
            content: 'Rút gọn biểu thức $Q = a^{\\frac{1}{3}} \\cdot \\sqrt{a}$ với $a > 0$ ta được:',
            options: ['A. $a^{\\frac{5}{6}}$', 'B. $a^{\\frac{1}{6}}$', 'C. $a^{\\frac{2}{3}}$', 'D. $a^{\\frac{4}{3}}$'],
            correctAnswer: 'A',
            explanation: 'Ta có $\\sqrt{a} = a^{\\frac{1}{2}}$. Khi đó $Q = a^{\\frac{1}{3}} \\cdot a^{\\frac{1}{2}} = a^{\\frac{1}{3} + \\frac{1}{2}} = a^{\\frac{5}{6}}$.',
            points: 2,
            order: 4,
          },
        ],
      },
    },
  });

  console.log('Sample Chapter Exam created successfully!');
}

async function main() {
  await ensureDefaultAdmin();
  await ensureSchool(prisma, 'THPT Lê Lợi');
  await ensureAcademicYear(prisma, '2025-2026');
  await ensureGrade(prisma, '10');
  await ensureGrade(prisma, '11');
  await ensureGrade(prisma, '12');

  await ensureStudentClass(prisma, '10A1', 'THPT Lê Lợi', '2025-2026');
  await ensureStudentClass(prisma, '11A1', 'THPT Lê Lợi', '2025-2026');
  await ensureStudentClass(prisma, '12A1', 'THPT Lê Lợi', '2025-2026');

  await seedStudent('hs10a1', '123456', 'Nguyễn Văn Mười', '10A1', 'THPT Lê Lợi', '2025-2026');
  await seedStudent('hs11a1', '123456', 'Trần Thị Mười Một', '11A1', 'THPT Lê Lợi', '2025-2026');
  await seedStudent('hs12a1', '123456', 'Lê Văn Mười Hai', '12A1', 'THPT Lê Lợi', '2025-2026');

  for (const lesson of sampleLessons) {
    await seedLessonExam(lesson);
  }

  await seedSampleChapterExam();

  console.log('Seed hoàn tất: admin/admin123, lớp theo năm học 2025-2026 và học liệu mẫu');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
