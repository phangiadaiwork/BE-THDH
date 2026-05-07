const { ensureDefaultAdmin } = require('../src/utils/ensureDefaultAdmin');

async function main() {
  await ensureDefaultAdmin();
  console.log('Seed hoàn tất: admin / admin123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
