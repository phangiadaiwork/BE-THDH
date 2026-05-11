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
 * Upload a single image/pdf, apply processing if image, return Base64 URL.
 */
router.post('/', authenticate, requireRole('TEACHER'), upload.any(), async (req, res) => {
  try {
    const file = req.files && req.files.length > 0 ? req.files[0] : req.file;
    if (!file) {
      return res.status(400).json({ error: 'Không tìm thấy file' });
    }

    const { mimetype, buffer } = file;
    const isPdf = mimetype === 'application/pdf';

    if (isPdf) {
      const base64Str = buffer.toString('base64');
      res.json({ url: `data:${mimetype};base64,${base64Str}` });
    } else {
      // Compress & convert to webp
      const webpBuffer = await sharp(buffer)
        .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
      
      const base64Str = webpBuffer.toString('base64');
      res.json({ url: `data:image/webp;base64,${base64Str}` });
    }
  } catch (error) {
    res.status(500).json({ error: 'Upload thất bại' });
  }
});

/**
 * DELETE /api/upload
 */
router.delete('/', authenticate, requireRole('TEACHER'), async (req, res) => {
  res.json({ message: 'Đã xóa ảnh' });
});

module.exports = router;
