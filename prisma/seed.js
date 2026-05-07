const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const { ensureDefaultAdmin } = require('../src/utils/ensureDefaultAdmin');
const { ensureGrade, ensureSchool, ensureStudentClass } = require('../src/utils/education');

const prisma = new PrismaClient();

const sampleLessons = [
  {
    gradeLevel: '12',
    chapterCode: 'chuong-vi',
    chapterTitle: 'Chương VI',
    chapterDisplayOrder: 6,
    lessonNumber: 18,
    lessonTitle: 'Lũy thừa với số mũ thực',
    theoryContent:
      'Khái niệm lũy thừa với số mũ thực, các tính chất cơ bản của lũy thừa, cách biến đổi biểu thức và nhận diện điều kiện xác định.',
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
    theoryContent:
      'Định nghĩa logarit, điều kiện xác định, các công thức đổi cơ số và các tính chất của logarit giúp rút gọn biểu thức.',
    exerciseTitle: 'Bài tập',
    nodes: [
      { tempId: '1', parentTempId: null, label: 'Logarit', question: 'Điều kiện để log_a b xác định là gì?', options: ['A. a > 0, a != 1, b > 0', 'B. a > 1, b >= 0', 'C. a != 0, b > 0', 'D. a > 0, b != 1'], correctAnswer: 'A', hint: 'Nhớ đủ điều kiện của cơ số và số bị logarit.', points: 1, order: 0 },
      { tempId: '2', parentTempId: '1', label: 'Công thức', question: 'log_a(a^m) bằng gì?', options: ['A. a+m', 'B. am', 'C. m', 'D. 1/m'], correctAnswer: 'C', hint: 'Logarit và lũy thừa là hai phép toán ngược nhau.', points: 1, order: 0 },
      { tempId: '3', parentTempId: '1', label: 'Đổi cơ số', question: 'Công thức đổi cơ số đúng là?', options: ['A. log_a b = log_c a / log_c b', 'B. log_a b = log_c b / log_c a', 'C. log_a b = log_a c / log_b c', 'D. log_a b = log_b c / log_a c'], correctAnswer: 'B', hint: 'Chia log của số bị logarit cho log của cơ số.', points: 1, order: 1 },
    ],
  },
  {
    gradeLevel: '12',
    chapterCode: 'chuong-vi',
    chapterTitle: 'Chương VI',
    chapterDisplayOrder: 6,
    lessonNumber: 20,
    lessonTitle: 'Hàm số mũ và hàm số logarit',
    theoryContent:
      'Nhận biết dạng hàm số mũ và hàm số logarit, tính đơn điệu, tập xác định, tập giá trị và một số dạng đồ thị cơ bản.',
    exerciseTitle: 'Bài tập',
    nodes: [
      { tempId: '1', parentTempId: null, label: 'Hàm số mũ', question: 'Hàm số y = a^x với a > 1 có tính chất nào?', options: ['A. Đồng biến trên R', 'B. Nghịch biến trên R', 'C. Không xác định với x < 0', 'D. Chỉ xác định khi x nguyên'], correctAnswer: 'A', hint: 'Đồ thị đi lên khi cơ số lớn hơn 1.', points: 1, order: 0 },
      { tempId: '2', parentTempId: '1', label: 'Hàm logarit', question: 'Hàm số y = log_a x với 0 < a < 1 là hàm như thế nào trên (0; +inf)?', options: ['A. Đồng biến', 'B. Nghịch biến', 'C. Hằng số', 'D. Không xác định'], correctAnswer: 'B', hint: 'Với cơ số nằm giữa 0 và 1, hàm logarit đi xuống.', points: 1, order: 0 },
      { tempId: '3', parentTempId: '1', label: 'Tập xác định', question: 'Tập xác định của y = log_a(x-2) là?', options: ['A. x > 0', 'B. x >= 2', 'C. x > 2', 'D. x != 2'], correctAnswer: 'C', hint: 'Biểu thức trong logarit phải dương.', points: 1, order: 1 },
    ],
  },
  {
    gradeLevel: '12',
    chapterCode: 'chuong-vi',
    chapterTitle: 'Chương VI',
    chapterDisplayOrder: 6,
    lessonNumber: 21,
    lessonTitle: 'Phương trình, bất phương trình mũ và logarit',
    theoryContent:
      'Các dạng phương trình và bất phương trình mũ, logarit thường gặp; phương pháp đưa về cùng cơ số, đặt ẩn phụ và điều kiện xác định.',
    exerciseTitle: 'Bài tập',
    nodes: [
      { tempId: '1', parentTempId: null, label: 'PT mũ', question: 'Phương trình 2^x = 8 có nghiệm là?', options: ['A. 2', 'B. 3', 'C. 4', 'D. 8'], correctAnswer: 'B', hint: 'Đưa 8 về lũy thừa cơ số 2.', points: 1, order: 0 },
      { tempId: '2', parentTempId: '1', label: 'PT logarit', question: 'log_2 x = 3 thì x bằng bao nhiêu?', options: ['A. 6', 'B. 8', 'C. 9', 'D. 12'], correctAnswer: 'B', hint: 'Đổi về dạng lũy thừa.', points: 1, order: 0 },
      { tempId: '3', parentTempId: '1', label: 'BPT logarit', question: 'Điều kiện của log_3(x-1) là gì?', options: ['A. x > 1', 'B. x >= 1', 'C. x > 0', 'D. x != 1'], correctAnswer: 'A', hint: 'Biểu thức trong logarit phải dương.', points: 1, order: 1 },
    ],
  },
];

async function seedStudent(username, password, fullName, className, schoolName) {
  const studentClass = await ensureStudentClass(prisma, className, schoolName);
  const hashedPassword = await bcrypt.hash(password, 10);

  await prisma.user.upsert({
    where: { username },
    update: {
      password: hashedPassword,
      fullName,
      role: 'STUDENT',
      classId: studentClass?.id ?? null,
    },
    create: {
      username,
      password: hashedPassword,
      fullName,
      role: 'STUDENT',
      classId: studentClass?.id ?? null,
    },
  });
}

async function seedLessonExam(item) {
  const grade = await ensureGrade(prisma, item.gradeLevel);

  const chapter = await prisma.chapter.upsert({
    where: {
      gradeId_code: {
        gradeId: grade.id,
        code: item.chapterCode,
      },
    },
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
    where: {
      chapterId_title: {
        chapterId: chapter.id,
        title: item.lessonTitle,
      },
    },
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

async function main() {
  await ensureDefaultAdmin();

  await ensureSchool(prisma, 'THPT Lê Lợi');
  await ensureGrade(prisma, '10');
  await ensureGrade(prisma, '11');
  await ensureGrade(prisma, '12');

  await ensureStudentClass(prisma, '10A1', 'THPT Lê Lợi');
  await ensureStudentClass(prisma, '11A1', 'THPT Lê Lợi');
  await ensureStudentClass(prisma, '12A1', 'THPT Lê Lợi');

  await seedStudent('hs10a1', '123456', 'Nguyễn Văn Mười', '10A1', 'THPT Lê Lợi');
  await seedStudent('hs11a1', '123456', 'Trần Thị Mười Một', '11A1', 'THPT Lê Lợi');
  await seedStudent('hs12a1', '123456', 'Lê Văn Mười Hai', '12A1', 'THPT Lê Lợi');

  for (const lesson of sampleLessons) {
    await seedLessonExam(lesson);
  }

  console.log('Seed hoàn tất: admin/admin123 và học liệu lớp 12 chương VI');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
