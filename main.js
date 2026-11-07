const { app, BrowserWindow, ipcMain, globalShortcut, screen, shell, clipboard, Notification, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { exec } = require('child_process');
const pdfParse = require('pdf-parse');
const { autoUpdater } = require('electron-updater');

const server = express();
const port = 3000;

let mainWindow;
let onboardingWindow;
let filedropWindow;
let lastClipboardText = '';
let lastActiveApp = '';

const memoryFile = path.join(app.getPath('userData'), 'kuku_memory.json');
const authFlagFile = path.join(app.getPath('userData'), 'kuku_authed.flag');
const everSignedInFile = path.join(app.getPath('userData'), 'kuku_ever_signed_in.flag');
const fileDropFlagFile = path.join(app.getPath('userData'), 'file_drop_video_shown.flag');

function deleteFileDropFlag() {
  try {
    if (fs.existsSync(fileDropFlagFile)) {
      fs.unlinkSync(fileDropFlagFile);
      console.log('🗑️ Deleted file drop flag');
    }
  } catch(e) {
    console.error('Failed to delete file drop flag:', e);
  }
}

const videos = [
  { src: 'onboarding1.mp4', title: 'Welcome to KUKU', pos: 'top-right', showBadge: false },
  { src: 'onboarding2.mp4', title: 'The Clipboard Shelf', pos: 'bottom-left', showBadge: true },
  { src: 'onboarding3.mp4', title: 'Meet Your AI Assistant', pos: 'top-left', showBadge: false }
];
let currentVideoIndex = 0;
let isReturningUserFlow = false;
let isFileDropVideoPlaying = false;
let fileDropSafetyTimeout = null;

function detectContentType(text) {
  if (!text || text.length < 3) return null;
  const trimmed = text.trim();
  if (/^(https?:\/\/|www\.)[^\s]+$/i.test(trimmed)) return { type: 'url', label: '🔗 Summarize Page', prompt: `Summarize the content of this URL: ${trimmed}` };
  if (/function |const |let |class |import |def |public |private |=>|\{.*\}|<\/?[a-z]+>/i.test(trimmed) && trimmed.length > 20) return { type: 'code', label: '💻 Explain Code', prompt: `Explain what this code does in simple terms:\n\n${trimmed}` };
  if (/(error|exception|failed|cannot|undefined|null pointer|stack trace)/i.test(trimmed) && trimmed.length > 15) return { type: 'error', label: '🔧 Fix Error', prompt: `This error occurred. Explain what's wrong and how to fix it:\n\n${trimmed}` };
  if (/[^\x00-\x7F]/.test(trimmed)) return { type: 'language', label: '🌍 Translate to English', prompt: `Translate this to English:\n\n${trimmed}` };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return { type: 'email', label: '✉️ Draft Email', prompt: `Write a professional email to ${trimmed}` };
  if (trimmed.length > 30) return { type: 'text', label: '✨ Explain This', prompt: `Explain this in simple terms:\n\n${trimmed}` };
  return null;
}

// 🔥 AUTO-UPDATER
function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    console.log('🔍 Checking for updates...');
  });

  autoUpdater.on('update-available', (info) => {
    console.log('✅ Update available:', info.version);
    if (Notification.isSupported()) {
      new Notification({
        title: '🚀 Update Available',
        body: `KUKU ${info.version} is downloading in the background...`
      }).show();
    }
  });

  autoUpdater.on('update-not-available', () => {
    console.log('✅ You are on the latest version');
  });

  autoUpdater.on('download-progress', (progressObj) => {
    console.log(`📥 Download: ${Math.round(progressObj.percent)}%`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('✅ Update downloaded:', info.version);
    
    if (Notification.isSupported()) {
      const notif = new Notification({
        title: '🎉 KUKU Update Ready',
        body: `Version ${info.version} is downloaded. Click to restart and apply.`,
      });
      
      notif.on('click', () => {
        autoUpdater.quitAndInstall(false, true);
      });
      
      notif.show();
    }
    
    if (mainWindow) {
      mainWindow.webContents.send('update-ready', info.version);
    }
  });

  autoUpdater.on('error', (err) => {
    console.error('❌ Update error:', err.message);
  });

  autoUpdater.checkForUpdates().catch(err => {
    console.log('⚠️ Update check failed:', err.message);
  });

  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 30 * 60 * 1000);
}

function createMainWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width } = primaryDisplay.workAreaSize;

  mainWindow = new BrowserWindow({
    width: 520, height: 460, x: Math.floor(width / 2 - 260), y: 0,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false, hasShadow: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });

  mainWindow.loadFile('index.html');

  globalShortcut.register('CommandOrControl+Q', () => mainWindow.webContents.send('toggle-island'));
  globalShortcut.register('CommandOrControl+W', () => mainWindow.webContents.send('open-chat'));
  globalShortcut.register('CommandOrControl+R', () => mainWindow.webContents.send('trigger-rain'));
  globalShortcut.register('CommandOrControl+Shift+S', () => mainWindow.webContents.send('start-screenshot'));

  setInterval(() => {
    const text = clipboard.readText();
    if (text && text !== lastClipboardText) {
      lastClipboardText = text;
      const context = detectContentType(text);
      mainWindow.webContents.send('clipboard-updated', { text, context });
    }
  }, 1000);

  setInterval(() => {
    const psScript = `powershell -NoProfile -Command "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class P{[DllImport(\\"user32.dll\\")]public static extern IntPtr GetForegroundWindow();[DllImport(\\"user32.dll\\")]public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);}'; $h=[P]::GetForegroundWindow(); $s=New-Object System.Text.StringBuilder 256; [void][P]::GetWindowText($h,$s,256); $s.ToString()"`;
    
    exec(psScript, (err, stdout) => {
      if (err || !stdout) return;
      const lowerTitle = stdout.trim().toLowerCase();
      if (!lowerTitle) return;

      let detectedApp = '';
      if (lowerTitle.includes('chrome')) detectedApp = 'Chrome';
      else if (lowerTitle.includes('edge')) detectedApp = 'Edge';
      else if (lowerTitle.includes('notepad')) detectedApp = 'Notepad';
      else if (lowerTitle.includes('vscode')) detectedApp = 'VS Code';
      else if (lowerTitle.includes('spotify')) detectedApp = 'Spotify';
      else if (lowerTitle.includes('explorer')) detectedApp = 'File Explorer';

      if (detectedApp && detectedApp !== lastActiveApp) {
        lastActiveApp = detectedApp;
        mainWindow.webContents.send('app-opened', detectedApp);
        setTimeout(() => { lastActiveApp = ''; }, 8000);
      }
    });
  }, 3000);
}

function createOnboardingWindow(videoData) {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  let x = width / 2 - 170; let y = height / 2 - 110;
  if (videoData.pos === 'top-right') { x = width - 360; y = 40; }
  if (videoData.pos === 'bottom-left') { x = 40; y = height - 260; }
  if (videoData.pos === 'top-left') { x = 40; y = 40; }

  const winWidth = videoData.showBadge ? 550 : 340;
  if (videoData.showBadge && videoData.pos === 'bottom-left') { x = 40; }
  if (videoData.showBadge && videoData.pos === 'top-right') { x = width - 570; }

  onboardingWindow = new BrowserWindow({
    width: winWidth, height: 220, x: Math.floor(x), y: Math.floor(y),
    frame: false, transparent: true, alwaysOnTop: true, resizable: false, hasShadow: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });

  onboardingWindow.loadFile('onboarding.html');
  onboardingWindow.webContents.on('did-finish-load', () => {
    onboardingWindow.webContents.send('play-video', videoData);
  });

  onboardingWindow.webContents.on('did-fail-load', () => {
    setTimeout(() => {
      if (onboardingWindow) {
        onboardingWindow.close();
        onboardingWindow = null;
        ipcMain.emit('video-finished');
      }
    }, 2000);
  });
}

function createFileDropVideoWindow() {
  if (isFileDropVideoPlaying) return;
  isFileDropVideoPlaying = true;

  const videoPath = path.join(__dirname, 'filedrop_intro.mp4');
  const htmlPath = path.join(__dirname, 'filedrop-video.html');

  if (!fs.existsSync(videoPath) || !fs.existsSync(htmlPath)) {
    console.log('⚠️ File drop video or HTML missing, skipping');
    isFileDropVideoPlaying = false;
    if (mainWindow) mainWindow.webContents.send('filedrop-video-done');
    return;
  }

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  filedropWindow = new BrowserWindow({
    width: 400,
    height: 260,
    x: Math.floor(width / 2 - 200),
    y: Math.floor(height / 2 - 130),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    hasShadow: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });

  filedropWindow.loadFile('filedrop-video.html');

  filedropWindow.webContents.on('did-finish-load', () => {
    console.log('📄 filedrop-video.html loaded');
    filedropWindow.webContents.send('play-filedrop-video');
  });

  filedropWindow.webContents.on('did-fail-load', () => {
    console.log('⚠️ File drop video failed to load');
    if (filedropWindow) filedropWindow.close();
    filedropWindow = null;
    isFileDropVideoPlaying = false;
    if (mainWindow) mainWindow.webContents.send('filedrop-video-done');
  });

  clearTimeout(fileDropSafetyTimeout);
  fileDropSafetyTimeout = setTimeout(() => {
    console.log('⚠️ File drop video 60s timeout');
    if (filedropWindow) filedropWindow.close();
    filedropWindow = null;
    isFileDropVideoPlaying = false;
    if (mainWindow) mainWindow.webContents.send('filedrop-video-done');
  }, 60000);

  filedropWindow.on('closed', () => {
    clearTimeout(fileDropSafetyTimeout);
    if (isFileDropVideoPlaying) {
      isFileDropVideoPlaying = false;
      if (mainWindow) mainWindow.webContents.send('filedrop-video-done');
    }
    filedropWindow = null;
  });
}

app.whenReady().then(() => {
  createMainWindow();
  
  if (app.isPackaged) {
    setupAutoUpdater();
  }
  
  if (!fs.existsSync(authFlagFile)) {
    mainWindow.hide();
    if (fs.existsSync(everSignedInFile)) {
      deleteFileDropFlag();
      createOnboardingWindow({ src: 'onboarding_welcome.mp4', title: 'Welcome Back!', pos: 'top-right', showBadge: false });
      currentVideoIndex = -1;
    } else {
      currentVideoIndex = 0;
      createOnboardingWindow(videos[currentVideoIndex]);
    }
  }
});

ipcMain.handle('check-returning-user', async () => {
  return !fs.existsSync(authFlagFile) && fs.existsSync(everSignedInFile);
});

ipcMain.on('play-return-onboarding', () => {
  isReturningUserFlow = true;
  if (mainWindow) mainWindow.hide();
  deleteFileDropFlag();
  createOnboardingWindow({ src: 'onboarding_welcome.mp4', title: 'Welcome Back!', pos: 'top-right', showBadge: false });
});

ipcMain.on('video-finished', () => {
  if (onboardingWindow) onboardingWindow.close();
  onboardingWindow = null;

  if (isReturningUserFlow) {
    isReturningUserFlow = false;
    if (mainWindow) { 
      mainWindow.show(); 
      mainWindow.webContents.send('welcome-video-finished'); 
    }
    return;
  }

  if (currentVideoIndex === -1) {
    if (mainWindow) { mainWindow.show(); mainWindow.webContents.send('open-profile'); }
    return;
  }

  currentVideoIndex++;
  if (currentVideoIndex < videos.length) {
    setTimeout(() => createOnboardingWindow(videos[currentVideoIndex]), 400);
  } else {
    if (mainWindow) { mainWindow.show(); mainWindow.webContents.send('open-profile'); }
  }
});

ipcMain.handle('check-and-play-filedrop-video', async () => {
  console.log('🔍 check-and-play-filedrop-video: flag exists?', fs.existsSync(fileDropFlagFile));
  
  if (!fs.existsSync(fileDropFlagFile)) {
    createFileDropVideoWindow();
    return true;
  }
  return false;
});

ipcMain.on('filedrop-video-finished', () => {
  console.log('✅ filedrop-video-finished received');
  clearTimeout(fileDropSafetyTimeout);
  try { fs.writeFileSync(fileDropFlagFile, 'true'); } catch(e) {}
  if (filedropWindow) filedropWindow.close();
  filedropWindow = null;
  isFileDropVideoPlaying = false;
  if (mainWindow) mainWindow.webContents.send('filedrop-video-done');
});

ipcMain.on('restart-for-update', () => {
  autoUpdater.quitAndInstall(false, true);
});

ipcMain.on('user-logged-in', () => { 
  fs.writeFileSync(authFlagFile, 'true'); 
  fs.writeFileSync(everSignedInFile, 'true'); 
});

ipcMain.on('user-logged-out', () => { 
  if (fs.existsSync(authFlagFile)) fs.unlinkSync(authFlagFile);
  deleteFileDropFlag();
  console.log('✅ Signed out — file drop flag cleared');
});

ipcMain.on('replay-onboarding', () => {
  if (mainWindow) mainWindow.hide();
  currentVideoIndex = 0;
  createOnboardingWindow(videos[currentVideoIndex]);
});

ipcMain.handle('capture-screen', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
  return sources[0].thumbnail.toDataURL();
});

ipcMain.handle('read-file', async (event, filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  const fileName = path.basename(filePath);
  
  try {
    if (ext === '.pdf') {
      const dataBuffer = fs.readFileSync(filePath);
      const data = await pdfParse(dataBuffer);
      return { type: 'text', name: fileName, content: data.text.substring(0, 5000) };
    }
    
    if (ext === '.docx' || ext === '.doc') {
      return { type: 'error', name: fileName, content: 'Word documents are not supported yet. Please save as PDF or TXT.' };
    }
    
    if (['.txt', '.md', '.js', '.py', '.html', '.css', '.json', '.csv'].includes(ext)) {
      const content = fs.readFileSync(filePath, 'utf-8').substring(0, 5000);
      return { type: 'text', name: fileName, content };
    }
    
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
      const base64 = fs.readFileSync(filePath).toString('base64');
      return { type: 'image', name: fileName, content: `data:image/${ext.replace('.', '')};base64,${base64}` };
    }

    return { type: 'error', name: fileName, content: `Unsupported file type: ${ext}` };
  } catch (err) {
    return { type: 'error', name: fileName, content: err.message };
  }
});

ipcMain.handle('open-browser-login', (event, url) => shell.openExternal(url));

server.get('/login-success', (req, res) => {
  res.send(`
    <html>
      <body style="background: #111; color: white; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center;">
        <div style="font-size: 60px;">✅</div>
        <h2 style="color: #1DB954; margin-top: 20px;">Login Successful!</h2>
        <p style="color: #aaa;">You can close this tab and return to KUKU.</p>
        <script>
          const hash = window.location.hash.substring(1);
          const params = new URLSearchParams(hash);
          const token = params.get('access_token');
          if (token) {
            fetch('/login-complete?token=' + encodeURIComponent(token))
              .then(() => {
                document.body.innerHTML = '<div style="font-size:60px">🎉</div><h2 style="color:#1DB954">You are now signed in!</h2>';
              });
          }
        </script>
      </body>
    </html>
  `);
});

server.get('/login-complete', (req, res) => {
  const token = req.query.token;
  if (mainWindow && token) {
    mainWindow.webContents.send('browser-login-token', token);
  }
  res.send('OK');
});

server.listen(port, () => console.log(`✅ Auth server running on http://localhost:${port}`));

ipcMain.handle('write-clipboard', (event, text) => clipboard.writeText(text));
ipcMain.handle('show-notification', (event, title, body) => new Notification({ title, body }).show());
ipcMain.handle('save-memory', (event, memoryText) => {
  let memories = [];
  if (fs.existsSync(memoryFile)) memories = JSON.parse(fs.readFileSync(memoryFile));
  memories.push(memoryText);
  fs.writeFileSync(memoryFile, JSON.stringify(memories, null, 2));
  return true;
});
ipcMain.handle('get-memories', () => {
  if (fs.existsSync(memoryFile)) return JSON.parse(fs.readFileSync(memoryFile));
  return [];
});

app.on('will-quit', () => globalShortcut.unregisterAll());