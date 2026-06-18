import pg from 'pg';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const { Pool } = pg;

const TABLES = [
  { name: 'users', columns: 'id, username, email, "fullName", bio, "avatar_url", role, "coin_balance", "kycStatus", "id_card_url", "verification_video_url", status, "country_code", "device_type", "last_login_ip", "last_active_at", "followers_count", "following_count", "is_anonymous", "banned_until", "locked_until", "failed_login_attempts", "created_at", "updated_at", "deleted_at"' },
  { name: 'transactions', columns: '*' },
  { name: 'gifts', columns: '*' },
  { name: 'user_follows', columns: '*' },
  { name: 'communities', columns: '*' },
  { name: 'community_participants', columns: '*' },
  { name: 'community_posts', columns: '*' },
  { name: 'community_post_reactions', columns: '*' },
  { name: 'groups', columns: '*' },
  { name: 'group_member', columns: '*' },
  { name: 'group_messages', columns: '*' },
  { name: 'group_message_reaction', columns: '*' },
  { name: 'tournaments', columns: '*' },
  { name: 'tournament_participants', columns: '*' },
  { name: 'tournament_matches', columns: '*' },
  { name: 'tournament_reports', columns: '*' },
  { name: 'live_sessions', columns: '*' },
  { name: 'stream_messages', columns: '*', limit: 5000, orderBy: '"createdAt" DESC' },
  { name: 'reports', columns: '*' },
  { name: 'system_logs', columns: '*', limit: 10000, orderBy: '"createdAt" DESC' },
  { name: 'notifications', columns: '*', limit: 10000, orderBy: '"createdAt" DESC' },
];

// ==========================================
// ENCRYPTION (AES-256-GCM)
// ==========================================
function encryptData(jsonString) {
  const key = crypto.scryptSync(process.env.ENCRYPTION_KEY || 'default-super-secret-key-change-me', 'salt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  let encrypted = cipher.update(jsonString, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  // Format: iv:authTag:encryptedData
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

// ==========================================
// DIFF ENGINE
// ==========================================
function computeTableHash(data) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(data));
  return hash.digest('hex');
}

async function run() {
  console.log('🚀 Backup started at', new Date().toISOString());

  const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'postgres',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
  });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  try {
    const client = await pool.connect();
    const data = {};
    const stats = {};
    const tableHashes = {};
    const diffs = {};

    console.log('📥 Fetching data & computing diffs...');
    for (const table of TABLES) {
      let query = `SELECT ${table.columns} FROM "${table.name}"`;
      if (table.orderBy) query += ` ORDER BY ${table.orderBy}`;
      if (table.limit) query += ` LIMIT ${table.limit}`;

      const result = await client.query(query);
      data[table.name] = result.rows;
      stats[table.name] = result.rows.length;
      
      const currentHash = computeTableHash(result.rows);
      tableHashes[table.name] = currentHash;
    }
    client.release();

    // 1. Check if a previous full backup exists to diff against
    const auth = new google.auth.JWT(
      process.env.GCP_CLIENT_EMAIL,
      null,
      process.env.GCP_PRIVATE_KEY.replace(/\\n/g, '\n'),
      ['https://www.googleapis.com/auth/drive.file']
    );
    const drive = google.drive({ version: 'v3', auth });

    const existingFiles = await drive.files.list({
      q: `'${process.env.GDRIVE_FOLDER_ID}' in parents and name contains 'backup-full-'`,
      fields: 'files(id, name)',
      orderBy: 'createdTime desc',
    });

    const prevFullBackup = existingFiles.data.files?.[0];
    let prevHashes = {};

    if (prevFullBackup) {
      console.log('🔍 Previous full backup found. Comparing...');
      try {
        const prevDataRes = await drive.files.get({ fileId: prevFullBackup.id, alt: 'media' }, { responseType: 'json' });
        // Note: If you enable encryption below, you'd have to decrypt this first. 
        // For true diffing to work WITH encryption, hashes must be stored unencrypted in metadata.
        prevHashes = prevDataRes.data?.metadata?.tableHashes || {};
      } catch (e) {
        console.log('⚠️ Could not read previous backup for diffing. Doing full backup.');
      }
    }

    // 2. Determine what changed
    let hasChanges = false;
    for (const [tableName, currentHash] of Object.entries(tableHashes)) {
      if (prevHashes[tableName] !== currentHash) {
        diffs[tableName] = data[tableName];
        hasChanges = true;
        console.log(`   🔄 Diff detected: ${tableName}`);
      }
    }

    if (!hasChanges) {
      console.log('✅ No changes detected since last backup. Skipping upload to save space.');
      return;
    }

    // 3. Build Payload
    let payload, fileName;

    // If >50% of tables changed, just do a full backup
    if (Object.keys(diffs).length > TABLES.length * 0.5) {
      fileName = `backup-full-${timestamp}.enc.json`;
      payload = {
        type: 'FULL',
        metadata: {
          timestamp: new Date().toISOString(),
          version: '4.0-encrypted',
          source: 'africom-fortress',
          tableHashes
        },
        stats,
        data
      };
      console.log('📦 Building FULL backup (major changes detected)...');
    } else {
      fileName = `backup-diff-${timestamp}.enc.json`;
      payload = {
        type: 'DIFF',
        basedOn: prevFullBackup?.name,
        metadata: {
          timestamp: new Date().toISOString(),
          version: '4.0-encrypted',
          source: 'africom-fortress',
          tableHashes
        },
        changedStats: Object.fromEntries(Object.entries(stats).filter(([k]) => diffs[k])),
        data: diffs
      };
      console.log('📦 Building INCREMENTAL diff backup...');
    }

    const jsonString = JSON.stringify(payload);
    
    // 4. Encrypt
    console.log('🔐 Encrypting with AES-256-GCM...');
    const encryptedString = encryptData(jsonString);

    // Write to temp file
    const filePath = path.join('/tmp', fileName);
    fs.writeFileSync(filePath, encryptedString);
    const sizeBytes = fs.statSync(filePath).size;
    console.log(`💾 Encrypted size: ${(sizeBytes / 1024 / 1024).toFixed(2)} MB`);

    // 5. Upload
    console.log('☁️ Uploading to Google Drive...');
    const newFile = await drive.files.create({
      requestBody: { name: fileName, parents: [process.env.GDRIVE_FOLDER_ID] },
      media: { mimeType: 'application/json', body: fs.createReadStream(filePath) },
    });

    // 6. Safety Verification
    console.log('🔒 Verifying...');
    const verify = await drive.files.get({ fileId: newFile.data.id, fields: 'id' });
    if (!verify.data.id) throw new Error('Upload verification failed');

    // 7. Cleanup old diffs IF a new full backup was just created
    if (payload.type === 'FULL') {
      console.log('🧹 Cleaning up old backups...');
      const allFiles = await drive.files.list({
        q: `'${process.env.GDRIVE_FOLDER_ID}' in parents and name contains 'backup-'`,
        fields: 'files(id, name)'
      });
      for (const file of allFiles.data.files || []) {
        if (file.id !== newFile.data.id) {
          await drive.files.delete({ fileId: file.id });
          console.log(`   🗑️ Deleted ${file.name}`);
        }
      }
    }

    fs.unlinkSync(filePath);
    console.log(`\n✅ ${payload.type} BACKUP COMPLETE & ENCRYPTED`);

  } catch (error) {
    console.error('❌ BACKUP FAILED:', error.message);
    throw error;
  } finally {
    await pool.end();
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});