const GRADE_CODES = ['10', '11', '12'];

function normalizeText(value, fallback = '') {
  return String(value ?? fallback).trim();
}

function parseOptionalInt(value) {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseGradeCodeFromClassName(className = '') {
  const match = normalizeText(className).match(/^(\d{2})/);
  return match?.[1] && GRADE_CODES.includes(match[1]) ? match[1] : '12';
}

function normalizeAcademicYearName(value) {
  const text = normalizeText(value);
  const match = text.match(/^(\d{4})\s*[-/]\s*(\d{4})$/);
  if (!match) return '';

  const startYear = parseInt(match[1], 10);
  const endYear = parseInt(match[2], 10);
  if (endYear !== startYear + 1) return '';

  return `${startYear}-${endYear}`;
}

function getDefaultAcademicYearName(now = new Date()) {
  const year = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}-${year + 1}`;
}

async function ensureAcademicYear(prisma, academicYearName) {
  const normalizedName = normalizeAcademicYearName(academicYearName) || getDefaultAcademicYearName();
  const [startYearText, endYearText] = normalizedName.split('-');
  const startYear = parseInt(startYearText, 10);
  const endYear = parseInt(endYearText, 10);

  return prisma.academicYear.upsert({
    where: { name: normalizedName },
    update: {
      startYear,
      endYear,
    },
    create: {
      name: normalizedName,
      startYear,
      endYear,
      isActive: normalizedName === getDefaultAcademicYearName(),
    },
  });
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
  if (!name) {
    throw new Error('Trường là bắt buộc');
  }

  return prisma.school.upsert({
    where: { name },
    update: {},
    create: { name },
  });
}

async function ensureStudentClass(prisma, className, schoolName, academicYearName) {
  const normalizedClassName = normalizeText(className);
  if (!normalizedClassName) {
    throw new Error('Lớp là bắt buộc');
  }

  const normalizedAcademicYearName = normalizeAcademicYearName(academicYearName);
  if (!normalizedAcademicYearName) {
    throw new Error('Năm học phải theo dạng YYYY-YYYY, ví dụ 2025-2026');
  }

  const grade = await ensureGrade(prisma, parseGradeCodeFromClassName(normalizedClassName));
  const school = await ensureSchool(prisma, schoolName);
  const academicYear = await ensureAcademicYear(prisma, normalizedAcademicYearName);

  const existing = await prisma.studentClass.findFirst({
    where: {
      name: normalizedClassName,
      schoolId: school.id,
      academicYearId: academicYear.id,
    },
    include: {
      grade: true,
      school: true,
      academicYear: true,
    },
  });

  if (existing) {
    if (existing.gradeId !== grade.id) {
      return prisma.studentClass.update({
        where: { id: existing.id },
        data: { gradeId: grade.id },
        include: {
          grade: true,
          school: true,
          academicYear: true,
        },
      });
    }
    return existing;
  }

  return prisma.studentClass.create({
    data: {
      name: normalizedClassName,
      gradeId: grade.id,
      schoolId: school.id,
      academicYearId: academicYear.id,
    },
    include: {
      grade: true,
      school: true,
      academicYear: true,
    },
  });
}

function validateStudentPayload(student) {
  const username = normalizeText(student.username);
  const password = normalizeText(student.password);
  const fullName = normalizeText(student.fullName);
  const className = normalizeText(student.className);
  const school = normalizeText(student.school);
  const academicYearName = normalizeAcademicYearName(student.academicYearName || student.academicYear);

  if (!username) return 'Thiếu username';
  if (!password || password.length < 6) return 'Mật khẩu phải có ít nhất 6 ký tự';
  if (!fullName) return 'Thiếu họ tên';
  if (!className) return 'Thiếu lớp';
  if (!school) return 'Thiếu trường';
  if (!academicYearName) return 'Năm học phải theo dạng YYYY-YYYY';

  return null;
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
    academicYearId: user.studentClass?.academicYear?.id ?? null,
    academicYearName: user.studentClass?.academicYear?.name ?? '',
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
    theoryPdf: lesson?.theoryPdf ?? null,
    theoryVideos: Array.isArray(lesson?.theoryVideos) ? lesson.theoryVideos : [],
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
      academicYearName: assignment.studentClass.academicYear?.name ?? '',
    })),
    createdAt: exam.createdAt,
    updatedAt: exam.updatedAt,
  };
}

module.exports = {
  GRADE_CODES,
  normalizeText,
  parseOptionalInt,
  parseGradeCodeFromClassName,
  normalizeAcademicYearName,
  getDefaultAcademicYearName,
  ensureAcademicYear,
  ensureGrade,
  ensureSchool,
  ensureStudentClass,
  validateStudentPayload,
  serializeStudent,
  serializeLessonExam,
};
