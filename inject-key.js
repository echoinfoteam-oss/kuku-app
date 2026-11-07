// inject-key.js
// Reads GROQ_API_KEY from .env and injects it into index.html from index.template.html

const fs = require('fs');
const path = require('path');

// Read .env manually (no dependency needed)
const envPath = path.join(__dirname, '.env');
if (!fs.existsSync(envPath)) {
  console.error('❌ .env file not found. Create one with GROQ_API_KEY=your_key_here');
  process.exit(1);
}

const envContent = fs.readFileSync(envPath, 'utf-8');
const match = envContent.match(/GROQ_API_KEY=(.+)/);
if (!match) {
  console.error('❌ GROQ_API_KEY not found in .env');
  process.exit(1);
}

const groqKey = match[1].trim();

// Read template
const templatePath = path.join(__dirname, 'index.template.html');
if (!fs.existsSync(templatePath)) {
  console.error('❌ index.template.html not found');
  process.exit(1);
}

const template = fs.readFileSync(templatePath, 'utf-8');

// Replace placeholder
const finalHtml = template.replace(/__GROQ_API_KEY__/g, groqKey);

// Write index.html
fs.writeFileSync(path.join(__dirname, 'index.html'), finalHtml);

console.log('✅ Injected Groq API key into index.html');