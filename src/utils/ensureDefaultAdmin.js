const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

async function ensureDefaultAdmin() {
  const prisma = new PrismaClient();

  try {
    // Tự động đảm bảo các bảng ChapterExam tồn tại trên Supabase/PostgreSQL kể cả khi chưa chạy migrate
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "ChapterExam" (
        "id" SERIAL PRIMARY KEY,
        "chapterId" INTEGER NOT NULL REFERENCES "Chapter"("id") ON DELETE CASCADE,
        "title" TEXT NOT NULL,
        "description" TEXT DEFAULT '',
        "duration" INTEGER DEFAULT 45,
        "isPublic" BOOLEAN DEFAULT true,
        "maxAttempts" INTEGER DEFAULT 1,
        "deletedAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `).catch((e) => console.log('Notice ChapterExam table check:', e.message));

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "ChapterExamAssignment" (
        "id" SERIAL PRIMARY KEY,
        "chapterExamId" INTEGER NOT NULL REFERENCES "ChapterExam"("id") ON DELETE CASCADE,
        "classId" INTEGER NOT NULL REFERENCES "StudentClass"("id") ON DELETE CASCADE,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "ChapterExamAssignment_chapterExamId_classId_key" UNIQUE ("chapterExamId", "classId")
      );
    `).catch((e) => console.log('Notice ChapterExamAssignment table check:', e.message));

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "ChapterQuestion" (
        "id" SERIAL PRIMARY KEY,
        "chapterExamId" INTEGER NOT NULL REFERENCES "ChapterExam"("id") ON DELETE CASCADE,
        "content" TEXT NOT NULL,
        "image" TEXT,
        "options" JSONB NOT NULL,
        "optionImages" JSONB,
        "correctAnswer" TEXT NOT NULL,
        "explanation" TEXT DEFAULT '',
        "explanationImage" TEXT,
        "points" DOUBLE PRECISION NOT NULL DEFAULT 1,
        "order" INTEGER NOT NULL DEFAULT 0
      );
    `).catch((e) => console.log('Notice ChapterQuestion table check:', e.message));

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "ChapterExamAttempt" (
        "id" SERIAL PRIMARY KEY,
        "userId" INTEGER NOT NULL REFERENCES "User"("id"),
        "chapterExamId" INTEGER NOT NULL REFERENCES "ChapterExam"("id") ON DELETE CASCADE,
        "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
        "totalPoints" DOUBLE PRECISION NOT NULL DEFAULT 0,
        "correctCount" INTEGER NOT NULL DEFAULT 0,
        "totalCount" INTEGER NOT NULL DEFAULT 0,
        "isComplete" BOOLEAN NOT NULL DEFAULT false,
        "outCount" INTEGER NOT NULL DEFAULT 0,
        "durationSpent" INTEGER NOT NULL DEFAULT 0,
        "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "submittedAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `).catch((e) => console.log('Notice ChapterExamAttempt table check:', e.message));

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "ChapterStudentAnswer" (
        "id" SERIAL PRIMARY KEY,
        "attemptId" INTEGER NOT NULL REFERENCES "ChapterExamAttempt"("id") ON DELETE CASCADE,
        "questionId" INTEGER NOT NULL REFERENCES "ChapterQuestion"("id") ON DELETE CASCADE,
        "selected" TEXT,
        "isCorrect" BOOLEAN NOT NULL DEFAULT false,
        "answeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "ChapterStudentAnswer_attemptId_questionId_key" UNIQUE ("attemptId", "questionId")
      );
    `).catch((e) => console.log('Notice ChapterStudentAnswer table check:', e.message));

    // Đảm bảo đủ các cột mới
    await prisma.$executeRawUnsafe(`ALTER TABLE "ChapterQuestion" ADD COLUMN IF NOT EXISTS "explanationImage" TEXT;`).catch(() => {});
    await prisma.$executeRawUnsafe(`ALTER TABLE "ChapterQuestion" ADD COLUMN IF NOT EXISTS "optionImages" JSONB;`).catch(() => {});
    await prisma.$executeRawUnsafe(`ALTER TABLE "ChapterExam" ADD COLUMN IF NOT EXISTS "maxAttempts" INTEGER DEFAULT 1;`).catch(() => {});
    await prisma.$executeRawUnsafe(`ALTER TABLE "ChapterExamAttempt" ADD COLUMN IF NOT EXISTS "outCount" INTEGER DEFAULT 0;`).catch(() => {});
    await prisma.$executeRawUnsafe(`ALTER TABLE "ChapterExamAttempt" ADD COLUMN IF NOT EXISTS "durationSpent" INTEGER DEFAULT 0;`).catch(() => {});

    const hashedPassword = await bcrypt.hash('admin123', 10);

    const teacher = await prisma.user.upsert({
      where: { username: 'admin' },
      update: {
        password: hashedPassword,
        fullName: 'Giáo viên',
        role: 'TEACHER',
        classId: null,
      },
      create: {
        username: 'admin',
        password: hashedPassword,
        fullName: 'Giáo viên',
        role: 'TEACHER',
        classId: null,
      },
    });

    console.log('Default admin ready:', teacher.username, '/ admin123');
  } finally {
    await prisma.$disconnect();
  }
}

module.exports = { ensureDefaultAdmin };
