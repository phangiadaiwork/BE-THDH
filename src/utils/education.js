const GRADE_CODES = ['10', '11', '12'];

function normalizeText(value, fallback = '') {
  return String(value ?? fallback).trim();
}

function parseGradeCodeFromClassName(className = '') {
  const match = normalizeText(className).match(/^(\d{2})/);
  return match?.[1] && GRADE_CODES.includes(match[1]) ? match[1] : '12';
}

async function ensureGrade(prisma, code) {
  const gradeCode = GRADE_CODES.includes(code) ? code : '12';
  return prisma.grade.upsert({
    where: { code: gradeCode },
    update: { title: `Lớp ${gradeCode}` },
    create: { code: gradeCode, title: `Lớp ${gradeCode}` },
  });
}

async function ensureSchool(prisma, schoolName) {
  const name = normalizeText(schoolName);
  if (!name) return null;

  return prisma.school.upsert({
    where: { name },
    update: {},
    create: { name },
  });
}

async function ensureStudentClass(prisma, className, schoolName) {
  const normalizedClassName = normalizeText(className);
  if (!normalizedClassName) return null;

  const grade = await ensureGrade(prisma, parseGradeCodeFromClassName(normalizedClassName));
  const school = await ensureSchool(prisma, schoolName);

  return prisma.studentClass.upsert({
    where: { name: normalizedClassName },
    update: {
      gradeId: grade.id,
      schoolId: school?.id ?? null,
    },
    create: {
      name: normalizedClassName,
      gradeId: grade.id,
      schoolId: school?.id ?? null,
    },
    include: {
      grade: true,
      school: true,
    },
  });
}

function serializeStudent(user) {
  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    role: user.role,
    classId: user.studentClass?.id ?? null,
    className: user.studentClass?.name ?? '',
    school: user.studentClass?.school?.name ?? '',
    gradeLevel: user.studentClass?.grade?.code ?? null,
  };
}

function serializeLessonExam(exam) {
  const lesson = exam.lesson;
  const chapter = lesson?.chapter;
  const grade = chapter?.grade;
  return {
    id: exam.id,
    title: exam.title,
    exerciseTitle: exam.exerciseTitle,
    isPublic: exam.isPublic,
    nodeCount: exam._count?.nodes ?? exam.nodes?.length ?? 0,
    lessonId: lesson?.id ?? null,
    lessonNumber: lesson?.number ?? null,
    lessonTitle: lesson?.title ?? '',
    theoryContent: lesson?.theoryContent ?? '',
    lessonDisplayOrder: lesson?.displayOrder ?? 0,
    chapterId: chapter?.id ?? null,
    chapterCode: chapter?.code ?? '',
    chapterTitle: chapter?.title ?? '',
    chapterDisplayOrder: chapter?.displayOrder ?? 0,
    gradeId: grade?.id ?? null,
    gradeLevel: grade?.code ?? '',
    gradeTitle: grade?.title ?? '',
    assignedClasses: (exam.assignments || []).map((assignment) => ({
      id: assignment.studentClass.id,
      name: assignment.studentClass.name,
      school: assignment.studentClass.school?.name ?? '',
      gradeLevel: assignment.studentClass.grade?.code ?? '',
    })),
    createdAt: exam.createdAt,
    updatedAt: exam.updatedAt,
  };
}

module.exports = {
  GRADE_CODES,
  normalizeText,
  parseGradeCodeFromClassName,
  ensureGrade,
  ensureSchool,
  ensureStudentClass,
  serializeStudent,
  serializeLessonExam,
};
