const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

async function ensureDefaultAdmin() {
  const prisma = new PrismaClient();

  try {
    // Tự động đảm bảo schema cơ sở dữ liệu trên Supabase/Postgres có đủ các cột mới
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
