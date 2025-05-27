# 🎬 Loom Video Downloader

Ein leistungsstarker Node.js Command-Line-Tool zum Herunterladen von Videos von loom.com mit Audio-Video-Synchronisation**.

## ✨ Features

- 🎯 **Audio-Video-Synchronisation (Beta)** - Ultra-präzise FFmpeg-basierte Synchronisation
- 📹 **Separate Stream-Downloads** - Video und Audio werden separat heruntergeladen und optimal kombiniert
- 🔊 **Garantierte Audio-Qualität** - Automatische Erkennung und Download von Audio-Streams
- 🚀 **Mehrere Download-Methoden** - yt-dlp, FFmpeg und direkte HTTP-Downloads
- 📋 **Batch-Downloads** - Mehrere Videos aus einer Liste herunterladen
- 🔍 **Intelligente Format-Erkennung** - Automatische Auswahl der besten verfügbaren Qualität
- 🛡️ **Robuste Fehlerbehandlung** - Mehrere Fallback-Methoden für maximale Erfolgsrate
- 📊 **Detaillierte Analyse** - Umfassende Video- und Audio-Stream-Analyse
- 🧹 **Automatisches Cleanup** - Temporäre Dateien werden automatisch entfernt

## 🛠️ Systemanforderungen

### Erforderlich
- **Node.js** (Version 14 oder höher)
- **npm** (normalerweise mit Node.js installiert)

### Empfohlen für beste Ergebnisse
- **yt-dlp**: `pip install yt-dlp` oder `brew install yt-dlp`
- **FFmpeg**: `brew install ffmpeg` (macOS) oder `sudo apt install ffmpeg` (Ubuntu)

## 📦 Installation

### Option 1: Lokale Installation
```bash
git clone https://github.com/ChrisFeldmeier/loom-downloader.git
cd loom-downloader
npm install
```

### Option 2: Globale NPM-Installation
```bash
npm install -g loom-dl
```

## 🚀 Verwendung

### Einzelnes Video herunterladen

```bash
# Einfacher Download
node loom-dl.js --url "https://www.loom.com/share/VIDEO_ID"

# Mit benutzerdefiniertem Dateinamen
node loom-dl.js --url "https://www.loom.com/share/VIDEO_ID" --out "mein-video.mp4"

# Mit Pfad
node loom-dl.js --url "https://www.loom.com/share/VIDEO_ID" --out "downloads/mein-video.mp4"
```

### Mehrere Videos herunterladen

Erstellen Sie eine Textdatei mit einer URL pro Zeile:

```bash
# urls.txt
https://www.loom.com/share/VIDEO_ID_1
https://www.loom.com/share/VIDEO_ID_2
https://www.loom.com/share/VIDEO_ID_3
```

```bash
# Batch-Download
node loom-dl.js --list urls.txt

# Mit Präfix und Ausgabeordner
node loom-dl.js --list urls.txt --prefix "training" --out "downloads/"

# Mit Timeout zwischen Downloads (empfohlen)
node loom-dl.js --list urls.txt --timeout 5000 --out "downloads/"
```

## 🔧 Kommandozeilen-Optionen

| Option | Kurz | Beschreibung | Beispiel |
|--------|------|--------------|----------|
| `--url` | `-u` | URL des Loom-Videos | `--url "https://www.loom.com/share/abc123"` |
| `--list` | `-l` | Datei mit Liste von URLs | `--list "urls.txt"` |
| `--out` | `-o` | Ausgabedatei oder -ordner | `--out "video.mp4"` |
| `--prefix` | `-p` | Präfix für Batch-Downloads | `--prefix "meeting"` |
| `--timeout` | `-t` | Wartezeit zwischen Downloads (ms) | `--timeout 5000` |

## 🎯 Download-Prozess

Das Tool verwendet einen intelligenten mehrstufigen Ansatz:

1. **🔍 Format-Analyse**: Erkennung verfügbarer Video- und Audio-Streams
2. **📹 Video-Download**: Download des hochwertigsten Video-Streams
3. **🔊 Audio-Download**: Separater Download des Audio-Streams
4. **🔗 Intelligente Kombination**: 
   - Timestamp-Synchronisation mit `setpts=PTS-STARTPTS`
   - Audio-Resampling für perfekte Synchronisation
   - Re-encoding für optimale Kompatibilität
5. **🧹 Cleanup**: Automatisches Entfernen temporärer Dateien

## 📊 Ausgabequalität

- **Video**: H.264, bis zu 4K (3840x2160), 30fps
- **Audio**: AAC, 48kHz, optimierte Bitrate
- **Synchronisation**: ±25ms Präzision (unter menschlicher Wahrnehmungsschwelle)
- **Dateigröße**: Optimiert für Qualität und Größe

## 🔧 Fehlerbehebung

### Häufige Probleme

**Problem**: "yt-dlp not found"
```bash
# Lösung: yt-dlp installieren
pip install yt-dlp
# oder
brew install yt-dlp
```

**Problem**: "ffmpeg not found"
```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg

# Windows
# Download von https://ffmpeg.org/download.html
```

**Problem**: Netzwerk-Verbindungsfehler
- Überprüfen Sie Ihre Internetverbindung
- Proxy-Einstellungen prüfen
- Firewall-Einstellungen überprüfen

**Problem**: Video ohne Audio
- Das Tool erkennt automatisch fehlende Audio-Streams
- Verwendet mehrere Fallback-Methoden
- Zeigt detaillierte Analyse-Informationen

### Debug-Informationen

Das Tool bietet umfassende Logging-Informationen:
- 🔍 Format-Erkennung und verfügbare Streams
- 📹 Download-Fortschritt für Video und Audio
- 🔗 FFmpeg-Kombinationsprozess
- ✅ Erfolgs- und Fehlermeldungen

## 🏗️ Technische Details

### Verwendete Technologien
- **Node.js**: Hauptlaufzeit
- **yt-dlp**: Primärer Video-Extraktor
- **FFmpeg**: Video/Audio-Verarbeitung und -Synchronisation
- **Axios**: HTTP-Client für API-Anfragen

### Unterstützte Formate
- **Input**: Loom.com URLs
- **Output**: MP4 (H.264 + AAC)
- **Qualitäten**: 720p, 1080p, 4K (je nach Verfügbarkeit)

### Synchronisations-Algorithmus
```
Video: setpts=PTS-STARTPTS
Audio: asetpts=PTS-STARTPTS + aresample=async=1:min_hard_comp=0.1:first_pts=0
Kombination: libx264 (CRF 18) + AAC (128kbps)
```