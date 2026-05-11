const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB limit for PDFs/Images
const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];

// Ensure uploads directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIMES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Chỉ cho phép file ảnh (JPG, PNG, GIF, WebP) hoặc file PDF'));
    }
  },
});

/**
 * POST /api/upload
 * Upload a single image/pdf, apply processing if image, return URL.
 */
router.post('/', authenticate, requireRole('TEACHER'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Không tìm thấy file' });
    }

    const { mimetype, buffer, originalname } = req.file;
    const isPdf = mimetype === 'application/pdf';
    const extension = isPdf ? 'pdf' : 'webp';
    const uniqueName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${extension}`;
    const outputPath = path.join(UPLOAD_DIR, uniqueName);

    if (isPdf) {
      fs.writeFileSync(outputPath, buffer);
    } else {
      // Compress & convert to webp
      await sharp(buffer)
        .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toFile(outputPath);
    }

    const fileUrl = `/uploads/${uniqueName}`;
    res.json({ url: fileUrl });
  } catch (error) {
    console.error('Upload error:', error);
    if (error.message?.includes('Chỉ cho phép')) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: 'Upload thất bại' });
  }
});

/**
 * DELETE /api/upload
 * Delete an uploaded image by its URL path.
 */
router.delete('/', authenticate, requireRole('TEACHER'), async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || !url.startsWith('/uploads/')) {
      return res.status(400).json({ error: 'URL không hợp lệ' });
    }

    const filename = path.basename(url);
    // Sanitize: only allow expected filename format
    if (!/^[\d]+-[a-f0-9]+\.(webp|pdf)$/.test(filename)) {
      return res.status(400).json({ error: 'Tên file không hợp lệ' });
    }

    const filePath = path.join(UPLOAD_DIR, filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    res.json({ message: 'Đã xóa ảnh' });
  } catch (error) {
    console.error('Delete upload error:', error);
    res.status(500).json({ error: 'Xóa ảnh thất bại' });
  }
});

module.exports = router;
