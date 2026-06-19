
import pg from 'pg';
import fs from 'fs';
import os from 'os';
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
  {
    name: 'stream_messages',
    columns: '*',
    limit: 5000,
    orderBy: '"createdAt" DESC'
  },
  { name: 'reports', columns: '*' },
  {
    name: 'system_logs',
    columns: '*',
    limit: 10000,
    orderBy: '"createdAt" DESC'
  },
  {
    name: 'notifications',
    columns: '*',
    limit: 10000,
    orderBy: '"createdAt" DESC'
  }
];

// =====================================================
// ENCRYPTION
// =====================================================

function encryptData(jsonString) {
  const key = crypto.scryptSync(
    process.env.ENCRYPTION_KEY || 'default-key',
    'salt',
    32
  );

  const iv = crypto.randomBytes(16);

  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    key,
    iv
  );

  let encrypted = cipher.update(
    jsonString,
    'utf8',
    'hex'
  );

  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag().toString('hex');

  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function computeTableHash(data) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(data))
    .digest('hex');
}

async function githubRequest(url, options = {}) {
  const res = await fetch(url, options);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `GitHub API Error (${res.status}): ${text}`
    );
  }

  return res;
}

async function run() {
  console.log(
    '🚀 Backup started at',
    new Date().toISOString()
  );

  const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'postgres',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: {
      rejectUnauthorized: false
    }
  });

  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-');

  let filePath = null;

  try {
    const client = await pool.connect();

    const data = {};
    const stats = {};
    const tableHashes = {};
    const diffs = {};

    console.log(
      '📥 Fetching data & computing hashes...'
    );

    for (const table of TABLES) {
      let query = `SELECT ${table.columns} FROM "${table.name}"`;

      if (table.orderBy) {
        query += ` ORDER BY ${table.orderBy}`;
      }

      if (table.limit) {
        query += ` LIMIT ${table.limit}`;
      }

      const result = await client.query(query);

      data[table.name] = result.rows;
      stats[table.name] = result.rows.length;
      tableHashes[table.name] = computeTableHash(
        result.rows
      );
    }

    client.release();

    let prevHashes = {};
    let hashFileSha = null;

    try {
      const metaRes = await fetch(
        `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/contents/latest-hashes.json`,
        {
          headers: {
            Authorization: `token ${process.env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json'
          }
        }
      );

      if (metaRes.ok) {
        const meta = await metaRes.json();

        hashFileSha = meta.sha;

        const hashRes = await fetch(
          `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/contents/latest-hashes.json`,
          {
            headers: {
              Authorization: `token ${process.env.GITHUB_TOKEN}`,
              Accept: 'application/vnd.github.v3.raw'
            }
          }
        );

        if (hashRes.ok) {
          prevHashes = await hashRes.json();
        }

        console.log(
          '🔍 Previous hash file found.'
        );
      }
    } catch {
      console.log(
        '⚠️ No previous hash file found.'
      );
    }

    let hasChanges = false;

    for (const [tableName, currentHash] of Object.entries(
      tableHashes
    )) {
      if (prevHashes[tableName] !== currentHash) {
        diffs[tableName] = data[tableName];
        hasChanges = true;

        console.log(
          `   🔄 Diff detected: ${tableName}`
        );
      }
    }

    if (!hasChanges) {
      console.log(
        '✅ No changes detected. Skipping backup.'
      );
      return;
    }

    let payload;
    let fileName;
    let tag;

    const changedCount =
      Object.keys(diffs).length;

    if (changedCount > TABLES.length * 0.5) {
      console.log(
        '📦 Building FULL backup...'
      );

      fileName =
        `backup-full-${timestamp}.enc.json`;

      tag = `v-full-${timestamp}`;

      payload = {
        type: 'FULL',
        metadata: {
          timestamp: new Date().toISOString(),
          version: '6.0-github',
          tableHashes
        },
        stats,
        data
      };
    } else {
      console.log(
        '📦 Building DIFF backup...'
      );

      fileName =
        `backup-diff-${timestamp}.enc.json`;

      tag = `v-diff-${timestamp}`;

      payload = {
        type: 'DIFF',
        metadata: {
          timestamp: new Date().toISOString(),
          version: '6.0-github',
          tableHashes
        },
        changedStats: Object.fromEntries(
          Object.entries(stats).filter(
            ([name]) => diffs[name]
          )
        ),
        data: diffs
      };
    }

    console.log(
      '🔐 Encrypting backup...'
    );

    const encryptedData = encryptData(
      JSON.stringify(payload)
    );

    filePath = path.join(
      os.tmpdir(),
      fileName
    );

    fs.writeFileSync(
      filePath,
      encryptedData
    );

    const sizeBytes =
      fs.statSync(filePath).size;

    console.log(
      `💾 Encrypted size: ${(
        sizeBytes /
        1024 /
        1024
      ).toFixed(2)} MB`
    );

    console.log(
      '☁️ Creating GitHub release...'
    );

    const releaseRes =
      await githubRequest(
        `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/releases`,
        {
          method: 'POST',
          headers: {
            Authorization: `token ${process.env.GITHUB_TOKEN}`,
            Accept:
              'application/vnd.github.v3+json',
            'Content-Type':
              'application/json'
          },
          body: JSON.stringify({
            tag_name: tag,
            name: `Backup ${timestamp}`,
            prerelease: true,
            body:
              `Automated ${payload.type} backup\n\n` +
              `Size: ${(
                sizeBytes /
                1024 /
                1024
              ).toFixed(2)} MB`
          })
        }
      );

    const release =
      await releaseRes.json();

    console.log(
      '☁️ Uploading asset...'
    );

    const fileBuffer =
      fs.readFileSync(filePath);

    const uploadUrl =
      `https://uploads.github.com/repos/${process.env.GITHUB_REPOSITORY}` +
      `/releases/${release.id}/assets?name=${encodeURIComponent(
        fileName
      )}`;

    await githubRequest(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `token ${process.env.GITHUB_TOKEN}`,
        'Content-Type':
          'application/octet-stream',
        'Content-Length':
          fileBuffer.length.toString()
      },
      body: fileBuffer
    });

    console.log(
      '✅ Asset uploaded successfully.'
    );

    console.log(
      '🧮 Updating hash tracker...'
    );

    const hashContent =
      Buffer.from(
        JSON.stringify(tableHashes)
      ).toString('base64');

    const updateBody = {
      message: `Update hashes ${timestamp}`,
      content: hashContent
    };

    if (hashFileSha) {
      updateBody.sha = hashFileSha;
    }

    try {
      await githubRequest(
        `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/contents/latest-hashes.json`,
        {
          method: 'PUT',
          headers: {
            Authorization: `token ${process.env.GITHUB_TOKEN}`,
            Accept:
              'application/vnd.github.v3+json',
            'Content-Type':
              'application/json'
          },
          body: JSON.stringify(updateBody)
        }
      );

      console.log(
        '✅ Hash tracker updated.'
      );
    } catch (err) {
      console.log(
        '⚠️ Failed to update hash tracker:',
        err.message
      );
    }

    console.log(
      `\n✅ ${payload.type} BACKUP COMPLETE`
    );
  } catch (error) {
    console.error(
      '❌ BACKUP FAILED:',
      error.message
    );

    throw error;
  } finally {
    if (
      filePath &&
      fs.existsSync(filePath)
    ) {
      fs.unlinkSync(filePath);
    }

    await pool.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
