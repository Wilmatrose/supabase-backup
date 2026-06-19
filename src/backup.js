import pg from 'pg';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const { Pool } = pg;

const TABLES = [
  { name: 'users', columns: '*' },
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
  const key = crypto.scryptSync(process.env.ENCRYPTION_KEY || 'default-key', 'salt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(jsonString, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

// ==========================================
// DIFF ENGINE
// ==========================================
function computeTableHash(data) {
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

async function run() {
  console.log('🚀 Backup started at', new Date().toISOString());

  const pool = new Pool({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'postgres', user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, ssl: { rejectUnauthorized: false },
  });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  try {
    const client = await pool.connect();
    const data = {}, stats = {}, tableHashes = {}, diffs = {};

    console.log('📥 Fetching data & computing diffs...');
    for (const table of TABLES) {
      let query = `SELECT ${table.columns} FROM "${table.name}"`;
      if (table.orderBy) query += ` ORDER BY ${table.orderBy}`;
      if (table.limit) query += ` LIMIT ${table.limit}`;
      const result = await client.query(query);
      data[table.name] = result.rows;
      stats[table.name] = result.rows.length;
      tableHashes[table.name] = computeTableHash(result.rows);
    }
    client.release();

    // 1. Download previous hashes from GitHub to compare
    let prevHashes = {};
    let hashFileSha = null;
    try {
      // Get the file metadata to grab the SHA (required for updating later)
      const metaRes = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/contents/latest-hashes.json`, {
        headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
      });
      
      if (metaRes.ok) {
        const meta = await metaRes.json();
        hashFileSha = meta.sha;
        
        // Fetch the actual raw content
        const hashRes = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/contents/latest-hashes.json`, {
          headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3.raw' }
        });
        if (hashRes.ok) prevHashes = await hashRes.json();
        console.log('🔍 Previous hashes found. Comparing...');
      }
    } catch (e) {
      console.log('⚠️ No previous backup found. Doing full backup.');
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
      console.log('✅ No changes detected. Skipping upload.');
      return;
    }

    // 3. Build Payload
    let payload, fileName, tag;

    if (Object.keys(diffs).length > TABLES.length * 0.5) {
      fileName = `backup-full-${timestamp}.enc.json`;
      tag = `v-full-${timestamp}`;
      payload = { type: 'FULL', metadata: { timestamp: new Date().toISOString(), version: '5.0-github', tableHashes }, stats, data };
      console.log('📦 Building FULL backup...');
    } else {
      fileName = `backup-diff-${timestamp}.enc.json`;
      tag = `v-diff-${timestamp}`;
      payload = { type: 'DIFF', metadata: { timestamp: new Date().toISOString(), version: '5.0-github', tableHashes }, changedStats: Object.fromEntries(Object.entries(stats).filter(([k]) => diffs[k])), data: diffs };
      console.log('📦 Building INCREMENTAL diff backup...');
    }

    // 4. Encrypt
    console.log('🔐 Encrypting with AES-256-GCM...');
    const encryptedString = encryptData(JSON.stringify(payload));
    
    // Write to temp file
    const filePath = path.join('/tmp', fileName);
    fs.writeFileSync(filePath, encryptedString);
    const sizeBytes = fs.statSync(filePath).size;
    console.log(`💾 Encrypted size: ${(sizeBytes / 1024 / 1024).toFixed(2)} MB`);

    // 5. Upload to GitHub Releases
    console.log('☁️ Uploading to GitHub Releases...');
    
    // Create the release
    const releaseRes = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/releases`, {
      method: 'POST',
      headers: {
        'Authorization': `token ${process.env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        tag_name: tag,
        name: `Backup ${timestamp}`,
        body: `Automated backup. Type: ${payload.type}. Size: ${(sizeBytes / 1024 / 1024).toFixed(2)} MB.`,
        prerelease: true
      })
    });
    
    if (!releaseRes.ok) {
      const errData = await releaseRes.json();
      throw new Error(`Failed to create release: ${errData.message}`);
    }
    
    const release = await releaseRes.json();

    // Upload the asset using the release ID (bulletproof method)
    const uploadUrl = `https://uploads.github.com/repos/${process.env.GITHUB_REPOSITORY}/releases/${release.id}/assets?name=${fileName}`;
    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': `token ${process.env.GITHUB_TOKEN}`,
        'Content-Type': 'application/octet-stream'
      },
      body: fs.createReadStream(filePath)
    });

    if (!uploadRes.ok) {
      throw new Error(`Failed to upload asset: ${await uploadRes.text()}`);
    }

    // 6. Update latest-hashes.json in the repo
    console.log('🧮 Updating hash tracker...');
    const hashBase64 = Buffer.from(JSON.stringify(tableHashes)).toString('base64');
    
    const hashUpdateBody = {
      message: `Update hashes ${timestamp}`,
      content: hashBase64,
    };
    
    // Only include SHA if the file already exists
    if (hashFileSha) {
      hashUpdateBody.sha = hashFileSha;
    }

    const hashUpdateRes = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/contents/latest-hashes.json`, {
      method: 'PUT',
      headers: {
        'Authorization': `token ${process.env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(hashUpdateBody)
    });

    if (!hashUpdateRes.ok) {
      console.log('⚠️ Could not update hash file (will do full backup next time).');
    } else {
      console.log('   ✓ Hash tracker updated.');
    }

    // 7. Cleanup old releases if it was a full backup
    if (payload.type === 'FULL') {
      console.log('🧹 Cleaning up old releases...');
      const relsRes = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/releases`, {
        headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
      });
      const releases = await relsRes.json();
      
      for (const rel of releases) {
        if (rel.tag_name !== tag) {
          await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/releases/${rel.id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}` }
          });
          console.log(`   🗑️ Deleted release: ${rel.tag_name}`);
        }
      }
    }

    fs.unlinkSync(filePath);
    console.log(`\n✅ ${payload.type} BACKUP COMPLETE & ENCRYPTED IN GITHUB`);

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