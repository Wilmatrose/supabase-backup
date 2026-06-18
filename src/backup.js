import pg from 'pg';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';

const { Pool } = pg;

const TABLES = [
  { name: 'users', columns: 'id, username, email, role, "coinBalance", "kycStatus", status, "deviceType", "countryCode", "lastLoginIp", "lastActiveAt", "followersCount", "followingCount", "createdAt", "updatedAt", "deletedAt"' },
  { name: 'transactions', columns: '*' },
  { name: 'groups', columns: 'id, name, description, "creatorId", "createdAt", "deletedAt"' },
  { name: 'communities', columns: 'id, name, description, "creatorId", "minCoinsToJoin", "createdAt", "deletedAt"' },
  { name: 'tournaments', columns: 'id, title, game, status, "hostId", "entryFeeCoins", "totalPot", "maxParticipants", "createdAt", "deletedAt"' },
  { name: 'reports', columns: '*' },
  { name: 'system_logs', columns: '*', limit: 10000, orderBy: '"createdAt" DESC' },
];

async function run() {
  console.log('🚀 Backup started at', new Date().toISOString());
  const pool = new Pool({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'postgres', user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, ssl: { rejectUnauthorized: false },
  });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `backup-${timestamp}.json`;
  const filePath = path.join('/tmp', fileName);

  try {
    const client = await pool.connect();
    const data = {}, stats = {};
    for (const table of TABLES) {
      let query = `SELECT ${table.columns} FROM "${table.name}"`;
      if (table.orderBy) query += ` ORDER BY ${table.orderBy}`;
      if (table.limit) query += ` LIMIT ${table.limit}`;
      const result = await client.query(query);
      data[table.name] = result.rows;
      stats[table.name] = result.rows.length;
      console.log(`   ✓ ${table.name}: ${result.rows.length} rows`);
    }
    client.release();

    const snapshot = { metadata: { timestamp: new Date().toISOString(), version: '2.0' }, stats, data };
    fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
    console.log(`💾 Size: ${(fs.statSync(filePath).size / 1024 / 1024).toFixed(2)} MB`);

    const auth = new google.auth.JWT(process.env.GCP_CLIENT_EMAIL, null, process.env.GCP_PRIVATE_KEY.replace(/\\n/g, '\n'), ['https://www.googleapis.com/auth/drive.file']);
    const drive = google.drive({ version: 'v3', auth });

    console.log('☁️ Uploading to Google Drive...');
    const newFile = await drive.files.create({
      requestBody: { name: fileName, parents: [process.env.GDRIVE_FOLDER_ID] },
      media: { mimeType: 'application/json', body: fs.readFileSync(filePath) },
    });
    console.log('   ✓ Uploaded');

    const oldFiles = await drive.files.list({ q: `'${process.env.GDRIVE_FOLDER_ID}' in parents and name contains 'backup-'`, fields: 'files(id, name)' });
    for (const file of oldFiles.data.files.filter(f => f.id !== newFile.data.id)) {
      await drive.files.delete({ fileId: file.id });
      console.log(`   🗑️ Deleted old: ${file.name}`);
    }
    fs.unlinkSync(filePath);
    console.log('✅ BACKUP COMPLETE');
  } catch (error) {
    console.error('❌ FAILED:', error.message);
    throw error;
  } finally { await pool.end(); }
}
run().catch(() => process.exit(1));
