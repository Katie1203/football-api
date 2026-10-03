const { app, BrowserWindow } = require('electron');
const path = require('path');

// Khởi động server Node.js (index.js) ngầm bên trong ứng dụng
require('./index.js');

function createWindow() {
    const mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        icon: path.join(__dirname, 'icon.png'), // Bạn có thể thêm icon hình quả bóng ở đây nếu muốn
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    // Sau khi server khởi động ở cổng 10000, Electron sẽ load trực tiếp giao diện Web vào app
    setTimeout(() => {
        mainWindow.loadURL('http://localhost:10000');
    }, 1500);
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.app.quit();
});