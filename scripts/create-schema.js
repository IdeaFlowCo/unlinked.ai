const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

async function executeSql(sql) {
  const serviceRoleKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZybm5oaWZ5ZXZtZmtheW9lbnlrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTczNTA5MzQwMCwiZXhwIjoyMDUwNjY5NDAwfQ.ZLIj0Ue6wm64Ba3Ml7i5AMZnSX7U6NJk19AqCKVZ6Iw';
  
  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': serviceRoleKey,
      'Authorization': `Bearer ${serviceRoleKey}`,
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify({
      query: sql,
      params: []
    })
  };

  console.log('Executing SQL:', sql);
  const response = await fetch('https://frnnhifyevmfkayoenyk.supabase.co/rest/v1/rpc/sql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': serviceRoleKey,
      'Authorization': `Bearer ${serviceRoleKey}`,
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify({
      query: sql,
      params: []
    })
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error('Response status:', response.status);
    console.error('Response headers:', Object.fromEntries(response.headers));
    console.error('Error text:', errorText);
    throw new Error(`HTTP ${response.status}: ${errorText}`);
  }
  
  const result = await response.json();
  console.log('Response:', result);
  return result;
}

async function createSchema() {
  try {
    const sqlPath = path.join(__dirname, '..', 'supabase', 'migrations', '20231225_create_tables.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    
    // Split SQL into separate statements (excluding comments and empty lines)
    const statements = sql
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt && !stmt.startsWith('--'));
    
    // Execute each statement
    for (const statement of statements) {
      if (!statement) continue;
      console.log(`Executing: ${statement.substring(0, 100)}...`);
      await executeSql(statement);
    }
    
    console.log('Schema created successfully!');
  } catch (err) {
    console.error('Error creating schema:', err);
    process.exit(1);
  }
}

createSchema();
