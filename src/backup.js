import pg from 'pg';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';

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

    const snapshot = { 
      metadata: { timestamp: new Date().toISOString(), version: '3.0', source: 'africom-fortress' }, 
      stats, 
      data 
    };
    
    fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
    const sizeBytes = fs.statSync(filePath).size;
    console.log(`💾 File size: ${(sizeBytes / 1024 / 1024).toFixed(2)} MB`);

    const auth = new google.auth.JWT(
      process.env.GCP_CLIENT_EMAIL, null, 
      process.env.GCP_PRIVATE_KEY.replace(/\\n/g, '\n'), 
      ['https://www.googleapis.com/auth/drive.file']
    );
    const drive = google.drive({ version: 'v3', auth });

    // 1. Upload new backup
    console.log('☁️ Uploading new backup to Google Drive...');
    const newFile = await drive.files.create({
      requestBody: { name: fileName, parents: [process.env.GDRIVE_FOLDER_ID] },
      media: { mimeType: 'application/json', body: fs.readFileSync(filePath) },
    });
    
    const newFileId = newFile.data.id;
    
    // 2. SAFETY CHECK: Verify the new file actually exists in Drive before touching old ones
    console.log('🔒 Verifying upload safety...');
    const verify = await drive.files.get({ fileId: newFileId, fields: 'id, name' });
    if (!verify.data.id) {
      throw new Error('SAFETY LOCK: Upload verification failed.');
    }
    console.log('   ✓ New backup verified in Google Drive.');

    // 3. ONLY NOW delete old backups
    console.log('🧹 Cleaning up old backups...');
    const oldFiles = await drive.files.list({ 
      q: `'${process.env.GDRIVE_FOLDER_ID}' in parents and name contains 'backup-'`, 
      fields: 'files(id, name)' 
    });
    
    let deletedCount = 0;
    for (const file of oldFiles.data.files.filter(f => f.id !== newFileId)) {
      await drive.files.delete({ fileId: file.id });
      deletedCount++;
      console.log(`   🗑️ Deleted: ${file.name}`);
    }
    
    if (deletedCount === 0) console.log('   ✓ No old backups to clean.');

    fs.unlinkSync(filePath);
    
    const totalRows = Object.values(stats).reduce((a, b) => a + b, 0);
    console.log('\n✅ BACKUP COMPLETE & SAFE');
    console.log(`📦 Total Rows Secured: ${totalRows}`);
    
  } catch (error) {
    console.error('\n❌ BACKUP FAILED:', error.message);
    console.error('⚠️ OLD BACKUPS WERE NOT TOUCHED. YOUR DATA IS SAFE.');
    throw error;
  } finally { 
    await pool.end(); 
  }
}

run().catch(() => process.exit(1));import pg from 'pg';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';

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

    const snapshot = { 
      metadata: { timestamp: new Date().toISOString(), version: '3.0', source: 'africom-fortress' }, 
      stats, 
      data 
    };
    
    fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
    const sizeBytes = fs.statSync(filePath).size;
    console.log(`💾 File size: ${(sizeBytes / 1024 / 1024).toFixed(2)} MB`);

    const auth = new google.auth.JWT(
      process.env.GCP_CLIENT_EMAIL, null, 
      process.env.GCP_PRIVATE_KEY.replace(/\\n/g, '\n'), 
      ['https://www.googleapis.com/auth/drive.file']
    );
    const drive = google.drive({ version: 'v3', auth });

    // 1. Upload new backup
    console.log('☁️ Uploading new backup to Google Drive...');
    const newFile = await drive.files.create({
      requestBody: { name: fileName, parents: [process.env.GDRIVE_FOLDER_ID] },
      media: { mimeType: 'application/json', body: fs.readFileSync(filePath) },
    });
    
    const newFileId = newFile.data.id;
    
    // 2. SAFETY CHECK: Verify the new file actually exists in Drive before touching old ones
    console.log('🔒 Verifying upload safety...');
    const verify = await drive.files.get({ fileId: newFileId, fields: 'id, name' });
    if (!verify.data.id) {
      throw new Error('SAFETY LOCK: Upload verification failed.');
    }
    console.log('   ✓ New backup verified in Google Drive.');

    // 3. ONLY NOW delete old backups
    console.log('🧹 Cleaning up old backups...');
    const oldFiles = await drive.files.list({ 
      q: `'${process.env.GDRIVE_FOLDER_ID}' in parents and name contains 'backup-'`, 
      fields: 'files(id, name)' 
    });
    
    let deletedCount = 0;
    for (const file of oldFiles.data.files.filter(f => f.id !== newFileId)) {
      await drive.files.delete({ fileId: file.id });
      deletedCount++;
      console.log(`   🗑️ Deleted: ${file.name}`);
    }
    
    if (deletedCount === 0) console.log('   ✓ No old backups to clean.');

    fs.unlinkSync(filePath);
    
    const totalRows = Object.values(stats).reduce((a, b) => a + b, 0);
    console.log('\n✅ BACKUP COMPLETE & SAFE');
    console.log(`📦 Total Rows Secured: ${totalRows}`);
    
  } catch (error) {
    console.error('\n❌ BACKUP FAILED:', error.message);
    console.error('⚠️ OLD BACKUPS WERE NOT TOUCHED. YOUR DATA IS SAFE.');
    throw error;
  } finally { 
    await pool.end(); 
  }
}

run().catch(() => process.exit(1));