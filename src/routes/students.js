const express = require('express');
const bcrypt = require('bcrypt');
const multer = require('multer');
const xlsx = require('xlsx');
const { PrismaClient } = require('@prisma/client');
const { authenticate, requireRole } = require('../middleware/auth');
const {
  ensureStudentClass,
  normalizeText,
  serializeStudent,
  validateStudentPayload,
  normalizeAcademicYearName,
} = require('../utils/education');

const router = express.Router();
const prisma = new PrismaClient();
const upload = multer({ storage: multer.memoryStorage() });

async function createStudentRecord(student) {
  const validationError = validateStudentPayload(student);
  if (validationError) {
    throw new Error(validationError);
  }

  const { username, password, fullName, className, school } = student;
  const academicYearName = normalizeAcademicYearName(student.academicYearName || student.academicYear);
  const hashed = await bcrypt.hash(password, 10);
  const studentClass = await ensureStudentClass(prisma, className, school, academicYearName);

  const user = await prisma.user.create({
    data: {
      username: normalizeText(username),
      password: hashed,
      fullName: normalizeText(fullName),
      classId: studentClass.id,
      role: 'STUDENT',
    },
    include: {
      studentClass: {
        include: {
          school: true,
          grade: true,
          academicYear: true,
        },
      },
    },
  });

  return serializeStudent(user);
}

function buildStudentImportRows(rows) {
  return rows.map((row, index) => ({
    rowNumber: index + 2,
    username: normalizeText(row.username),
    password: normalizeText(row.password),
    fullName: normalizeText(row.fullName),
    className: normalizeText(row.className),
    school: normalizeText(row.school),
    academicYearName: normalizeText(row.academicYearName || row.academicYear),
  }));
}

function collectDuplicateUsernames(students) {
  const seen = new Set();
  const duplicates = new Set();

  students.forEach((student) => {
    const username = student.username.toLowerCase();
    if (seen.has(username)) duplicates.add(username);
    seen.add(username);
  });

  return duplicates;
}

router.post('/bulk', authenticate, requireRole('TEACHER'), async (req, res) => {
  try {
    const { students } = req.body;

    if (!Array.isArray(students) || students.length === 0) {
      return res.status(400).json({ error: 'Cần cung cấp danh sách học sinh' });
    }

    const created = [];
    const errors = [];
    const duplicates = collectDuplicateUsernames(students);

    for (const student of students) {
      const username = normalizeText(student.username);
      if (duplicates.has(username.toLowerCase())) {
        errors.push({ username, error: 'Username bị trùng trong danh sách import' });
        continue;
      }

      try {
        created.push(await createStudentRecord(student));
      } catch (err) {
        errors.push({
          username: username || '?',
          error: err.code === 'P2002' ? 'Tên đăng nhập đã tồn tại' : err.message,
        });
      }
    }

    res.json({ created, errors });
  } catch (error) {
    console.error('Bulk create error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/template', authenticate, requireRole('TEACHER'), (_req, res) => {
  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.aoa_to_sheet([
    ['username', 'password', 'fullName', 'className', 'school', 'academicYearName'],
    ['hs001', 'matkhau123', 'Nguyễn Văn A', '10A1', 'THPT Lê Lợi', '2025-2026'],
    ['hs002', 'matkhau456', 'Trần Thị B', '11A1', 'THPT Lê Lợi', '2025-2026'],
    ['hs003', 'matkhau789', 'Lê Văn C', '12A1', 'THPT Lê Lợi', '2025-2026'],
  ]);
  ws['!cols'] = [{ wch: 14 }, { wch: 14 }, { wch: 22 }, { wch: 10 }, { wch: 20 }, { wch: 16 }];
  xlsx.utils.book_append_sheet(wb, ws, 'HocSinh');
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="mau_hoc_sinh.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

router.post('/import', authenticate, requireRole('TEACHER'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Cần upload file Excel' });

    const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(ws, { defval: '' });

    if (rows.length === 0) return res.status(400).json({ error: 'File không có dữ liệu' });

    const students = buildStudentImportRows(rows);
    const duplicates = collectDuplicateUsernames(students);
    const created = [];
    const errors = [];

    for (const student of students) {
      if (duplicates.has(student.username.toLowerCase())) {
        errors.push({
          rowNumber: student.rowNumber,
          username: student.username || '?',
          error: 'Username bị trùng trong file Excel',
        });
        continue;
      }

      try {
        created.push(await createStudentRecord(student));
      } catch (err) {
        errors.push({
          rowNumber: student.rowNumber,
          username: student.username || '?',
          error: err.code === 'P2002' ? 'Tên đăng nhập đã tồn tại' : err.message,
        });
      }
    }

    res.json({ created, errors });
  } catch (error) {
    console.error('Import students error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/', authenticate, requireRole('TEACHER'), async (_req, res) => {
  try {
    const students = await prisma.user.findMany({
      where: { role: 'STUDENT' },
      include: {
        studentClass: {
          include: {
            school: true,
            grade: true,
            academicYear: true,
          },
        },
      },
      orderBy: { fullName: 'asc' },
    });

    res.json(
      students
        .sort((a, b) =>
          (a.studentClass?.academicYear?.name || '').localeCompare(b.studentClass?.academicYear?.name || '', 'vi') ||
          (a.studentClass?.grade?.code || '').localeCompare(b.studentClass?.grade?.code || '', 'vi') ||
          (a.studentClass?.name || '').localeCompare(b.studentClass?.name || '', 'vi') ||
          a.fullName.localeCompare(b.fullName, 'vi')
        )
        .map((student) => ({
          ...serializeStudent(student),
          createdAt: student.createdAt,
        }))
    );
  } catch (error) {
    console.error('Get students error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id', authenticate, requireRole('TEACHER'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { fullName, className, school, username, academicYearName } = req.body;

    const data = {};
    if (fullName !== undefined) data.fullName = normalizeText(fullName);
    if (username !== undefined) data.username = normalizeText(username);
    if (className !== undefined || school !== undefined || academicYearName !== undefined) {
      const studentClass = await ensureStudentClass(
        prisma,
        className,
        school,
        academicYearName
      );
      data.classId = studentClass.id;
    }

    const updated = await prisma.user.update({
      where: { id },
      data,
      include: {
        studentClass: {
          include: {
            school: true,
            grade: true,
            academicYear: true,
          },
        },
      },
    });

    res.json(serializeStudent(updated));
  } catch (error) {
    if (error.code === 'P2002') return res.status(400).json({ error: 'Tên đăng nhập đã tồn tại' });
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

router.put('/:id/reset-password', authenticate, requireRole('TEACHER'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { newPassword } = req.body;

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Mật khẩu phải ít nhất 6 ký tự' });
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({ where: { id }, data: { password: hashed } });
    res.json({ message: 'Đã đặt lại mật khẩu thành công' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', authenticate, requireRole('TEACHER'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await prisma.user.delete({ where: { id } });
    res.json({ message: 'Đã xóa học sinh' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
