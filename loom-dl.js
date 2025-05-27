#!/usr/bin/env node
import axios from 'axios';
import fs, { promises as fsPromises } from 'fs';
import https from 'https';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const argv = yargs(hideBin(process.argv))
  .option('url', {
    alias: 'u',
    type: 'string',
    description: 'Url of the video in the format https://www.loom.com/share/[ID]'
  })
  .option('list', {
    alias: 'l',
    type: 'string',
    description: 'Filename of the text file containing the list of URLs'
  })
  .option('prefix', {
    alias: 'p',
    type: 'string',
    description: 'Prefix for the output filenames when downloading from a list'
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Path to output the file to or directory to output files when using --list'
  })
  .option('timeout', {
    alias: 't',
    type: 'number',
    description: 'Timeout in milliseconds to wait between downloads when using --list'
  })
  .check((argv) => {
    if (!argv.url && !argv.list) {
      throw new Error('Please provide either a single video URL with --url or a list of URLs with --list to proceed');
    }
    if (argv.url && argv.list) {
      throw new Error('Please provide either --url or --list, not both');
    }
    if (argv.timeout && argv.timeout < 0) {
      throw new Error('Please provide a non-negative number for --timeout');
    }
    return true;
  })
  .help()
  .alias('help', 'h')
  .argv;

// Create axios instance with cookie jar
const axiosInstance = axios.create({
  withCredentials: true,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
  }
});

const fetchLoomDownloadUrl = async (id) => {
  try {
    console.log(`Fetching video page for ID: ${id}`);
    const videoPageUrl = `https://www.loom.com/share/${id}`;
    console.log(`Making request to: ${videoPageUrl}`);
    
    const response = await axiosInstance.get(videoPageUrl, {
      timeout: 30000
    });
    
    console.log(`Successfully received video page (status: ${response.status})`);
    
    // Extract cookies for later use
    const cookies = response.headers['set-cookie'];
    if (cookies) {
      console.log('Extracted cookies for authentication');
    }
    
    // Save HTML for debugging
    await fsPromises.writeFile(path.join(__dirname, 'debug-page.html'), response.data);
    console.log('Saved page HTML to debug-page.html for analysis');
    
    // Look for video URL in the page HTML
    const html = response.data;
    
    // Try to find the video URL in various possible locations
    let videoUrl = null;
    
    // Method 1: Look for Apollo State data (most reliable)
    const apolloStateRegex = /window\.__APOLLO_STATE__\s*=\s*({.*?});/s;
    const apolloMatch = apolloStateRegex.exec(html);
    if (apolloMatch && apolloMatch[1]) {
      try {
        const apolloState = JSON.parse(apolloMatch[1]);
        console.log('Found Apollo State data');
        
        // Look for video data in Apollo state
        for (const key in apolloState) {
          if (key.startsWith('RegularUserVideo:') && apolloState[key]) {
            const videoData = apolloState[key];
            
            // Try to find M3U8 URL (HLS stream)
            if (videoData['nullableRawCdnUrl({"acceptableMimes":["M3U8"]})']) {
              const m3u8Data = videoData['nullableRawCdnUrl({"acceptableMimes":["M3U8"]})'];
              if (m3u8Data && m3u8Data.url) {
                videoUrl = m3u8Data.url;
                console.log('Found M3U8 URL in Apollo state');
                break;
              }
            }
            
            // Try to find DASH URL as fallback
            if (!videoUrl && videoData['nullableRawCdnUrl({"acceptableMimes":["DASH"]})']) {
              const dashData = videoData['nullableRawCdnUrl({"acceptableMimes":["DASH"]})'];
              if (dashData && dashData.url) {
                videoUrl = dashData.url;
                console.log('Found DASH URL in Apollo state');
                break;
              }
            }
          }
        }
      } catch (parseError) {
        console.log('Failed to parse Apollo state:', parseError.message);
      }
    }
    
    // Method 2: Look for direct MP4 URLs
    if (!videoUrl) {
      const mp4Regex = /https:\/\/[^"'\s]+\.mp4[^"'\s]*/g;
      const mp4Matches = html.match(mp4Regex);
      if (mp4Matches && mp4Matches.length > 0) {
        // Find the highest quality video URL (usually the longest one)
        videoUrl = mp4Matches.reduce((longest, current) => 
          current.length > longest.length ? current : longest
        );
        console.log('Found MP4 URL');
      }
    }
    
    // Method 3: Look for video URLs in script tags
    if (!videoUrl) {
      const scriptRegex = /"videoUrl":\s*"([^"]+)"/g;
      const scriptMatch = scriptRegex.exec(html);
      if (scriptMatch && scriptMatch[1]) {
        videoUrl = scriptMatch[1].replace(/\\u002F/g, '/');
      }
    }
    
    // Method 4: Look for download URLs
    if (!videoUrl) {
      const downloadRegex = /"downloadUrl":\s*"([^"]+)"/g;
      const downloadMatch = downloadRegex.exec(html);
      if (downloadMatch && downloadMatch[1]) {
        videoUrl = downloadMatch[1].replace(/\\u002F/g, '/');
      }
    }
    
    // Method 5: Look for any video-related URLs
    if (!videoUrl) {
      const videoRegex = /"[^"]*video[^"]*":\s*"(https:\/\/[^"]+)"/gi;
      const videoMatch = videoRegex.exec(html);
      if (videoMatch && videoMatch[1]) {
        videoUrl = videoMatch[1].replace(/\\u002F/g, '/');
      }
    }
    
    console.log(`Extracted video URL: ${videoUrl}`);
    
    if (!videoUrl) {
      // Try the old API as fallback
      console.log('No video URL found in page, trying old API...');
      try {
        const { data } = await axios.post(`https://www.loom.com/api/campaigns/sessions/${id}/transcoded-url`, {}, {
          timeout: 30000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          }
        });
        if (data && data.url) {
          videoUrl = data.url;
          console.log(`Got video URL from old API: ${videoUrl}`);
        }
      } catch (apiError) {
        console.log(`Old API also failed: ${apiError.message}`);
      }
    }
    
    if (!videoUrl) {
      throw new Error('No video download URL found. The video might be private or the download might be disabled.');
    }
    
    return videoUrl;
  } catch (error) {
    console.error(`Error fetching download URL: ${error.message}`);
    if (error.response) {
      console.error(`Response status: ${error.response.status}`);
    }
    if (error.code === 'ECONNREFUSED') {
      console.error('Connection refused - this might be a proxy or DNS issue');
      console.error('Try checking your network settings or proxy configuration');
    }
    throw error;
  }
};

const backoff = (retries, fn, delay = 1000) => fn().catch(err => retries > 1 && delay <= 32000 ? new Promise(resolve => setTimeout(resolve, delay)).then(() => backoff(retries - 1, fn, delay * 2)) : Promise.reject(err));

const downloadLoomVideo = async (url, outputPath) => {
  try {
    console.log(`Starting download from: ${url}`);
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Method 1: Try yt-dlp first (most reliable for protected content)
    const ytDlpAvailable = await checkYtDlpAvailability();
    if (ytDlpAvailable) {
      try {
        console.log('Trying yt-dlp method...');
        await downloadWithYtDlp(url, outputPath);
        return; // Success, exit early
      } catch (ytDlpError) {
        console.log(`yt-dlp failed: ${ytDlpError.message}`);
        console.log('Falling back to ffmpeg...');
      }
    }

    // Method 2: Try ffmpeg with enhanced headers
    if (url.includes('.m3u8')) {
      console.log('Detected M3U8 stream, using ffmpeg for download...');
      
      const { spawn } = await import('child_process');
      
      return new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
          '-user_agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          '-headers', 'Referer: https://www.loom.com/',
          '-headers', 'Accept: */*',
          '-headers', 'Accept-Language: en-US,en;q=0.9',
          '-headers', 'Origin: https://www.loom.com',
          '-headers', 'Sec-Fetch-Dest: empty',
          '-headers', 'Sec-Fetch-Mode: cors',
          '-headers', 'Sec-Fetch-Site: cross-site',
          '-i', url,
          '-c', 'copy',
          '-bsf:a', 'aac_adtstoasc',
          '-y', // Overwrite output file
          outputPath
        ]);

        ffmpeg.stdout.on('data', (data) => {
          console.log(`ffmpeg stdout: ${data}`);
        });

        ffmpeg.stderr.on('data', (data) => {
          console.log(`ffmpeg progress: ${data}`);
        });

        ffmpeg.on('close', (code) => {
          if (code === 0) {
            console.log(`Download completed successfully`);
            resolve();
          } else {
            reject(new Error(`ffmpeg exited with code ${code}`));
          }
        });

        ffmpeg.on('error', (err) => {
          console.error(`ffmpeg error: ${err.message}`);
          reject(err);
        });
      });
    } else {
      // Method 3: Handle regular MP4 downloads with enhanced headers
      const file = fs.createWriteStream(outputPath);
      await new Promise((resolve, reject) => {
        const options = {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Referer': 'https://www.loom.com/',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Origin': 'https://www.loom.com',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'cross-site'
          }
        };

        https.get(url, options, function (response) {
          console.log(`Download response status: ${response.statusCode}`);
          if (response.statusCode === 403) {
            reject(new Error('Received 403 Forbidden'));
          } else if (response.statusCode === 302 || response.statusCode === 301) {
            console.log(`Redirect to: ${response.headers.location}`);
            reject(new Error(`Received redirect ${response.statusCode} to ${response.headers.location}`));
          } else if (response.statusCode !== 200) {
            reject(new Error(`Received status code ${response.statusCode}`));
          } else {
            response.pipe(file);
            file.on('finish', () => {
              file.close();
              console.log(`Download completed successfully`);
              resolve();
            });
          }
        }).on('error', (err) => {
          console.error(`HTTPS request error: ${err.message}`);
          fs.unlink(outputPath, () => { }); // Delete partial file
          reject(err);
        });
      });
    }
  } catch (error) {
    console.error(`Error during download process: ${error.message}`);
    throw error; // Rethrow to handle in backoff
  }
};

const appendToLogFile = async (id) => {
  await fsPromises.appendFile(path.join(__dirname, 'downloaded.log'), `${id}\n`);
};

const readDownloadedLog = async () => {
  try {
    const data = await fsPromises.readFile(path.join(__dirname, 'downloaded.log'), 'utf8');
    return new Set(data.split(/\r?\n/));
  } catch (error) {
    return new Set(); // If file doesn't exist, return an empty set
  }
};

const extractId = (url) => {
  url = url.split('?')[0];
  return url.split('/').pop();
};

const delay = (duration) => {
  return new Promise(resolve => setTimeout(resolve, duration));
};

// Test network connectivity
const testNetworkConnectivity = async () => {
  try {
    console.log('Testing network connectivity...');
    const response = await axios.get('https://www.loom.com', {
      timeout: 30000, // Increased to 30 seconds
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    console.log(`✓ Successfully connected to Loom (status: ${response.status})`);
    return true;
  } catch (error) {
    console.error(`✗ Network connectivity test failed: ${error.message}`);
    console.log('⚠️  Continuing anyway - network test might be too strict');
    return true; // Continue anyway, the test might be too strict
  }
};

// Check if ffmpeg is available
const checkFfmpegAvailability = async () => {
  try {
    const { spawn } = await import('child_process');
    return new Promise((resolve) => {
      const ffmpeg = spawn('ffmpeg', ['-version']);
      ffmpeg.on('close', (code) => {
        if (code === 0) {
          console.log('✓ ffmpeg is available');
          resolve(true);
        } else {
          console.log('✗ ffmpeg is not available or not working properly');
          resolve(false);
        }
      });
      ffmpeg.on('error', () => {
        console.log('✗ ffmpeg is not installed');
        console.log('Please install ffmpeg to download M3U8 streams:');
        console.log('macOS: brew install ffmpeg');
        console.log('Ubuntu: sudo apt install ffmpeg');
        console.log('Windows: Download from https://ffmpeg.org/download.html');
        resolve(false);
      });
    });
  } catch (error) {
    console.log('✗ Error checking ffmpeg availability:', error.message);
    return false;
  }
};

// Check if yt-dlp is available
const checkYtDlpAvailability = async () => {
  try {
    const { spawn } = await import('child_process');
    return new Promise((resolve) => {
      const ytdlp = spawn('yt-dlp', ['--version']);
      ytdlp.on('close', (code) => {
        if (code === 0) {
          console.log('✓ yt-dlp is available');
          resolve(true);
        } else {
          console.log('✗ yt-dlp is not available or not working properly');
          resolve(false);
        }
      });
      ytdlp.on('error', () => {
        console.log('✗ yt-dlp is not installed');
        console.log('Install yt-dlp for better video downloading:');
        console.log('pip install yt-dlp');
        console.log('or: brew install yt-dlp');
        resolve(false);
      });
    });
  } catch (error) {
    console.log('✗ Error checking yt-dlp availability:', error.message);
    return false;
  }
};

// Helper function to control concurrency
async function asyncPool(poolLimit, array, iteratorFn) {
  const ret = [];
  const executing = [];
  for (const item of array) {
    const p = Promise.resolve().then(() => iteratorFn(item, array));
    ret.push(p);

    if (poolLimit <= array.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= poolLimit) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.all(ret);
}

// Modified downloadFromList to use asyncPool for controlled concurrency
const downloadFromList = async () => {
  const downloadedSet = await readDownloadedLog();
  const filePath = path.resolve(argv.list);
  const fileContent = await fsPromises.readFile(filePath, 'utf8');
  const urls = fileContent.split(/\r?\n/).filter(url => url.trim() && !downloadedSet.has(url));
  const outputDirectory = argv.out ? path.resolve(argv.out) : path.join(__dirname, 'Downloads');

  // Define the download task for each URL, including a delay after each download
  const downloadTask = async (url) => {
    const id = extractId(url);
    try {
      const downloadUrl = await fetchLoomDownloadUrl(id);
      // Modify filename to include the video ID at the end
      let filename = argv.prefix ? `${argv.prefix}-${urls.indexOf(url) + 1}-${id}.mp4` : `${id}.mp4`;
      let outputPath = path.join(outputDirectory, filename);
      console.log(`Downloading video ${id} and saving to ${outputPath}`);
      await backoff(5, () => downloadLoomVideo(downloadUrl, outputPath));
      await appendToLogFile(url);
      console.log(`Waiting for 5 seconds before the next download...`);
      await delay(5000); // 5-second delay
    } catch (error) {
      console.error(`Failed to download video ${id}: ${error.message}`);
    }
  };

  // Use asyncPool to control the concurrency of download tasks
  const concurrencyLimit = 5; // Adjust the concurrency limit as needed
  await asyncPool(concurrencyLimit, urls, downloadTask);
};

const downloadSingleFile = async () => {
  const id = extractId(argv.url);
  
  // Step 1: Check available formats first
  const ytDlpAvailable = await checkYtDlpAvailability();
  if (ytDlpAvailable) {
    try {
      console.log('🔍 Step 1: Analyzing available formats...');
      const formatInfo = await listAvailableFormats(argv.url);
      
      if (!formatInfo.hasAudio) {
        console.log('⚠️  WARNING: No audio formats detected in available streams!');
        console.log('This might explain why downloaded videos have no sound.');
      }
      
      console.log('🔄 Step 2: Attempting download with separate streams method...');
      const filename = argv.out || `${id}`;
      await downloadWithSeparateStreams(argv.url, filename);
      
      console.log('✅ Separate streams download completed successfully!');
      return;
      
    } catch (separateStreamsError) {
      console.log(`Separate streams download failed: ${separateStreamsError.message}`);
      console.log('Falling back to manual URL extraction...');
    }
  }
  
  // Method 2: Extract video URL manually and download
  try {
    const url = await fetchLoomDownloadUrl(id);
    const filename = argv.out || `${id}.mp4`;
    console.log(`Downloading video ${id} and saving to ${filename}`);
    await downloadLoomVideo(url, filename);
  } catch (error) {
    console.error(`Failed to download video ${id}: ${error.message}`);
    
    // Method 3: Suggest alternative approaches
    console.log('\n=== Alternative Download Methods ===');
    console.log('1. Try downloading directly from the browser:');
    console.log(`   - Open: ${argv.url}`);
    console.log('   - Click the three dots (...) menu');
    console.log('   - Select "Download" if available');
    console.log('');
    console.log('2. Use screen recording:');
    console.log('   - Install OBS Studio: https://obsproject.com/');
    console.log('   - Record the video while playing');
    console.log('');
    console.log('3. Try browser extensions:');
    console.log('   - Video DownloadHelper (Firefox/Chrome)');
    console.log('   - Flash Video Downloader (Chrome)');
    
    throw error;
  }
};

// Download with yt-dlp as alternative
const downloadWithYtDlp = async (videoUrl, outputPath) => {
  try {
    console.log('Attempting download with yt-dlp...');
    const { spawn } = await import('child_process');
    
    return new Promise((resolve, reject) => {
      const ytdlp = spawn('yt-dlp', [
        '--user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        '--referer', 'https://www.loom.com/',
        '--add-header', 'Accept:*/*',
        '--add-header', 'Accept-Language:en-US,en;q=0.9',
        '--format', 'best[ext=mp4]/best', // Ensure we get the best quality with audio
        '--merge-output-format', 'mp4', // Merge audio and video into MP4
        '--verbose', // More detailed output for debugging
        '-o', outputPath,
        videoUrl
      ]);

      ytdlp.stdout.on('data', (data) => {
        console.log(`yt-dlp: ${data}`);
      });

      ytdlp.stderr.on('data', (data) => {
        console.log(`yt-dlp: ${data}`);
      });

      ytdlp.on('close', (code) => {
        if (code === 0) {
          console.log(`Download completed successfully with yt-dlp`);
          resolve();
        } else {
          reject(new Error(`yt-dlp exited with code ${code}`));
        }
      });

      ytdlp.on('error', (err) => {
        console.error(`yt-dlp error: ${err.message}`);
        reject(err);
      });
    });
  } catch (error) {
    console.error(`Error during yt-dlp download: ${error.message}`);
    throw error;
  }
};

// Alternative download method with explicit audio/video handling
const downloadWithYtDlpAdvanced = async (videoUrl, outputPath) => {
  try {
    console.log('Attempting advanced download with yt-dlp (separate audio/video handling)...');
    const { spawn } = await import('child_process');
    
    return new Promise((resolve, reject) => {
      const ytdlp = spawn('yt-dlp', [
        '--user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        '--referer', 'https://www.loom.com/',
        '--add-header', 'Accept:*/*',
        '--add-header', 'Accept-Language:en-US,en;q=0.9',
        '--format', 'bestvideo+bestaudio/best', // Try to get separate video and audio streams
        '--merge-output-format', 'mp4',
        '--no-check-certificate', // Skip SSL certificate verification
        '--no-playlist', // Don't download playlist
        '--write-info-json', // Write metadata for debugging
        '--verbose', // Detailed logging
        '--force-overwrites',
        '-o', outputPath,
        videoUrl
      ]);

      ytdlp.stdout.on('data', (data) => {
        const output = data.toString();
        console.log(`yt-dlp advanced: ${output}`);
        
        // Look for audio stream information in the output
        if (output.includes('audio')) {
          console.log('🔊 Audio stream detected in yt-dlp output!');
        }
        if (output.includes('video')) {
          console.log('📹 Video stream detected in yt-dlp output!');
        }
      });

      ytdlp.stderr.on('data', (data) => {
        const output = data.toString();
        console.log(`yt-dlp advanced: ${output}`);
        
        // Look for format information
        if (output.includes('format')) {
          console.log('📋 Format information detected');
        }
      });

      ytdlp.on('close', (code) => {
        if (code === 0) {
          console.log(`Advanced download completed successfully with yt-dlp`);
          resolve();
        } else {
          reject(new Error(`yt-dlp advanced exited with code ${code}`));
        }
      });

      ytdlp.on('error', (err) => {
        console.error(`yt-dlp advanced error: ${err.message}`);
        reject(err);
      });
    });
  } catch (error) {
    console.error(`Error during yt-dlp advanced download: ${error.message}`);
    throw error;
  }
};

// Function to list available formats for debugging
const listAvailableFormats = async (videoUrl) => {
  try {
    console.log('🔍 Checking available formats and audio streams...');
    const { spawn } = await import('child_process');
    
    return new Promise((resolve, reject) => {
      const ytdlp = spawn('yt-dlp', [
        '--list-formats',
        '--user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        '--referer', 'https://www.loom.com/',
        '--verbose',
        videoUrl
      ]);

      let output = '';
      let hasAudioFormats = false;
      let hasVideoFormats = false;
      
      ytdlp.stdout.on('data', (data) => {
        const chunk = data.toString();
        output += chunk;
        console.log(`Available formats: ${chunk}`);
        
        // Check for audio and video formats
        if (chunk.toLowerCase().includes('audio') || chunk.includes('m4a') || chunk.includes('aac')) {
          hasAudioFormats = true;
          console.log('🔊 AUDIO FORMAT DETECTED!');
        }
        if (chunk.toLowerCase().includes('video') || chunk.includes('mp4') || chunk.includes('m3u8')) {
          hasVideoFormats = true;
          console.log('📹 VIDEO FORMAT DETECTED!');
        }
      });

      ytdlp.stderr.on('data', (data) => {
        const chunk = data.toString();
        console.log(`Format check: ${chunk}`);
        
        if (chunk.includes('Available formats')) {
          console.log('📋 Format listing started');
        }
      });

      ytdlp.on('close', (code) => {
        console.log('=== FORMAT ANALYSIS SUMMARY ===');
        console.log(`Audio formats available: ${hasAudioFormats ? '✅ YES' : '❌ NO'}`);
        console.log(`Video formats available: ${hasVideoFormats ? '✅ YES' : '❌ NO'}`);
        console.log('===============================');
        
        if (code === 0) {
          console.log('Format check completed');
          resolve({
            output,
            hasAudio: hasAudioFormats,
            hasVideo: hasVideoFormats
          });
        } else {
          reject(new Error(`Format check failed with code ${code}`));
        }
      });

      ytdlp.on('error', (err) => {
        console.error(`Format check error: ${err.message}`);
        reject(err);
      });
    });
  } catch (error) {
    console.error(`Error checking formats: ${error.message}`);
    throw error;
  }
};

// Function to analyze video file for audio streams
const analyzeVideoFile = async (filePath) => {
  try {
    console.log(`Analyzing video file: ${filePath}`);
    const { spawn } = await import('child_process');
    
    return new Promise((resolve, reject) => {
      const ffprobe = spawn('ffprobe', [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_streams',
        '-show_format',
        filePath
      ]);

      let output = '';
      ffprobe.stdout.on('data', (data) => {
        output += data.toString();
      });

      ffprobe.stderr.on('data', (data) => {
        console.log(`ffprobe stderr: ${data}`);
      });

      ffprobe.on('close', (code) => {
        if (code === 0) {
          try {
            const analysis = JSON.parse(output);
            console.log('=== VIDEO ANALYSIS ===');
            console.log(`File: ${filePath}`);
            console.log(`Duration: ${analysis.format.duration} seconds`);
            console.log(`Size: ${(analysis.format.size / 1024 / 1024).toFixed(2)} MB`);
            
            const videoStreams = analysis.streams.filter(s => s.codec_type === 'video');
            const audioStreams = analysis.streams.filter(s => s.codec_type === 'audio');
            
            console.log(`Video streams found: ${videoStreams.length}`);
            videoStreams.forEach((stream, i) => {
              console.log(`  Video ${i}: ${stream.codec_name} ${stream.width}x${stream.height} @ ${stream.r_frame_rate} fps`);
            });
            
            console.log(`Audio streams found: ${audioStreams.length}`);
            if (audioStreams.length === 0) {
              console.log('❌ NO AUDIO STREAMS FOUND!');
            } else {
              audioStreams.forEach((stream, i) => {
                console.log(`  ✅ Audio ${i}: ${stream.codec_name} ${stream.channels} channels @ ${stream.sample_rate}Hz`);
              });
            }
            console.log('======================');
            
            resolve({
              hasAudio: audioStreams.length > 0,
              audioStreams: audioStreams.length,
              videoStreams: videoStreams.length,
              duration: analysis.format.duration,
              size: analysis.format.size
            });
          } catch (parseError) {
            reject(new Error(`Failed to parse ffprobe output: ${parseError.message}`));
          }
        } else {
          reject(new Error(`ffprobe failed with code ${code}`));
        }
      });

      ffprobe.on('error', (err) => {
        reject(new Error(`ffprobe error: ${err.message}`));
      });
    });
  } catch (error) {
    console.error(`Error analyzing video: ${error.message}`);
    throw error;
  }
};

// Download with explicit audio extraction and merging
const downloadWithAudioExtraction = async (videoUrl, outputPath) => {
  try {
    console.log('🎵 Attempting download with explicit audio extraction...');
    const { spawn } = await import('child_process');
    
    return new Promise((resolve, reject) => {
      const ytdlp = spawn('yt-dlp', [
        '--user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        '--referer', 'https://www.loom.com/',
        '--add-header', 'Accept:*/*',
        '--add-header', 'Accept-Language:en-US,en;q=0.9',
        '--format', 'bestvideo+bestaudio/best', // Explicitly try to get separate streams
        '--merge-output-format', 'mp4',
        '--postprocessor-args', 'ffmpeg:-c:v copy -c:a aac', // Ensure audio is properly encoded
        '--verbose',
        '--force-overwrites',
        '-o', outputPath,
        videoUrl
      ]);

      ytdlp.stdout.on('data', (data) => {
        const output = data.toString();
        console.log(`yt-dlp audio extraction: ${output}`);
        
        if (output.includes('Merging formats')) {
          console.log('🔄 MERGING AUDIO AND VIDEO STREAMS!');
        }
        if (output.includes('audio')) {
          console.log('🔊 Audio processing detected!');
        }
      });

      ytdlp.stderr.on('data', (data) => {
        const output = data.toString();
        console.log(`yt-dlp audio extraction: ${output}`);
      });

      ytdlp.on('close', (code) => {
        if (code === 0) {
          console.log(`Audio extraction download completed successfully`);
          resolve();
        } else {
          reject(new Error(`yt-dlp audio extraction exited with code ${code}`));
        }
      });

      ytdlp.on('error', (err) => {
        console.error(`yt-dlp audio extraction error: ${err.message}`);
        reject(err);
      });
    });
  } catch (error) {
    console.error(`Error during audio extraction download: ${error.message}`);
    throw error;
  }
};

// Download with explicit audio and video stream combination for Loom
const downloadWithExplicitAudioVideo = async (videoUrl, outputPath) => {
  try {
    console.log('🎬 Attempting download with explicit audio+video combination...');
    const { spawn } = await import('child_process');
    
    return new Promise((resolve, reject) => {
      const ytdlp = spawn('yt-dlp', [
        '--user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        '--referer', 'https://www.loom.com/',
        '--add-header', 'Accept:*/*',
        '--add-header', 'Accept-Language:en-US,en;q=0.9',
        '--format', 'hls-raw-audio-audio+hls-raw-5500/hls-raw-audio-audio+hls-raw-3200/hls-raw-audio-audio+hls-raw-1500/best', // Explicitly combine audio with video
        '--merge-output-format', 'mp4',
        '--verbose',
        '--force-overwrites',
        '-o', outputPath,
        videoUrl
      ]);

      ytdlp.stdout.on('data', (data) => {
        const output = data.toString();
        console.log(`yt-dlp explicit A+V: ${output}`);
        
        if (output.includes('Merging formats')) {
          console.log('🔄 MERGING AUDIO AND VIDEO STREAMS!');
        }
        if (output.includes('audio')) {
          console.log('🔊 Audio processing detected!');
        }
        if (output.includes('video')) {
          console.log('📹 Video processing detected!');
        }
      });

      ytdlp.stderr.on('data', (data) => {
        const output = data.toString();
        console.log(`yt-dlp explicit A+V: ${output}`);
      });

      ytdlp.on('close', (code) => {
        if (code === 0) {
          console.log(`Explicit audio+video download completed successfully`);
          resolve();
        } else {
          reject(new Error(`yt-dlp explicit A+V exited with code ${code}`));
        }
      });

      ytdlp.on('error', (err) => {
        console.error(`yt-dlp explicit A+V error: ${err.message}`);
        reject(err);
      });
    });
  } catch (error) {
    console.error(`Error during explicit A+V download: ${error.message}`);
    throw error;
  }
};

// Download video and audio separately (without combining)
const downloadWithSeparateStreams = async (videoUrl, outputPath) => {
  try {
    console.log('🎬 Downloading video and audio streams separately...');
    const { spawn } = await import('child_process');
    const path = await import('path');
    
    const outputDir = path.dirname(outputPath);
    const baseName = path.basename(outputPath, path.extname(outputPath));
    const videoOutput = path.join(outputDir, `${baseName}_video.mp4`);
    const audioOutput = path.join(outputDir, `${baseName}_audio.mp4`);
    
    // Download video stream
    console.log('📹 Downloading video stream...');
    await new Promise((resolve, reject) => {
      const ytdlpVideo = spawn('yt-dlp', [
        '--user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        '--referer', 'https://www.loom.com/',
        '--add-header', 'Accept:*/*',
        '--add-header', 'Accept-Language:en-US,en;q=0.9',
        '--format', 'hls-raw-5500/hls-raw-3200/hls-raw-1500/best[height<=2160]',
        '--force-overwrites',
        '-o', videoOutput,
        videoUrl
      ]);

      ytdlpVideo.stdout.on('data', (data) => {
        console.log(`📹 Video: ${data}`);
      });

      ytdlpVideo.stderr.on('data', (data) => {
        console.log(`📹 Video: ${data}`);
      });

      ytdlpVideo.on('close', (code) => {
        if (code === 0) {
          console.log(`✅ Video stream saved to: ${videoOutput}`);
          resolve();
        } else {
          reject(new Error(`Video download failed with code ${code}`));
        }
      });

      ytdlpVideo.on('error', (err) => {
        reject(err);
      });
    });
    
    // Download audio stream
    console.log('🔊 Downloading audio stream...');
    await new Promise((resolve, reject) => {
      const ytdlpAudio = spawn('yt-dlp', [
        '--user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        '--referer', 'https://www.loom.com/',
        '--add-header', 'Accept:*/*',
        '--add-header', 'Accept-Language:en-US,en;q=0.9',
        '--format', 'hls-raw-audio-audio',
        '--force-overwrites',
        '-o', audioOutput,
        videoUrl
      ]);

      ytdlpAudio.stdout.on('data', (data) => {
        console.log(`🔊 Audio: ${data}`);
      });

      ytdlpAudio.stderr.on('data', (data) => {
        console.log(`🔊 Audio: ${data}`);
      });

      ytdlpAudio.on('close', (code) => {
        if (code === 0) {
          console.log(`✅ Audio stream saved to: ${audioOutput}`);
          resolve();
        } else {
          reject(new Error(`Audio download failed with code ${code}`));
        }
      });

      ytdlpAudio.on('error', (err) => {
        reject(err);
      });
    });
    
    console.log('🎉 Separate streams download completed successfully!');
    console.log(`📹 Video file: ${videoOutput}`);
    console.log(`🔊 Audio file: ${audioOutput}`);
    
    // Combine video and audio automatically
    console.log('🔗 Combining video and audio streams...');
    const combinedOutput = path.join(outputDir, `${baseName}_combined.mp4`);
    
    await new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', [
        '-i', videoOutput,
        '-i', audioOutput,
        '-filter_complex', 
        '[0:v]setpts=PTS-STARTPTS[v];[1:a]asetpts=PTS-STARTPTS,aresample=async=1:min_hard_comp=0.100000:first_pts=0[a]',
        '-map', '[v]',         // Use filtered video with reset timestamps
        '-map', '[a]',         // Use filtered audio with reset timestamps and resampling
        '-c:v', 'libx264',     // Re-encode video for perfect sync
        '-preset', 'fast',     // Fast encoding preset
        '-crf', '18',          // High quality
        '-c:a', 'aac',         // Re-encode audio
        '-b:a', '128k',        // Audio bitrate
        '-ar', '48000',        // Audio sample rate
        '-ac', '1',            // Mono audio
        '-avoid_negative_ts', 'make_zero',
        '-fflags', '+genpts+igndts',  // Generate PTS and ignore DTS
        '-max_muxing_queue_size', '1024',  // Increase muxing queue
        '-y',                  // Overwrite output file
        combinedOutput
      ]);

      ffmpeg.stdout.on('data', (data) => {
        console.log(`🔗 FFmpeg: ${data}`);
      });

      ffmpeg.stderr.on('data', (data) => {
        console.log(`🔗 FFmpeg: ${data}`);
      });

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          console.log(`✅ Successfully combined video and audio!`);
          console.log(`🎬 Combined file: ${combinedOutput}`);
          
          // Keep separate files for user reference
          console.log('📁 Separate files preserved:');
          console.log(`📹 Video file: ${videoOutput}`);
          console.log(`🔊 Audio file: ${audioOutput}`);
          console.log(`🎬 Combined file: ${combinedOutput}`);
          
          resolve();
        } else {
          reject(new Error(`FFmpeg failed with code ${code}`));
        }
      });

      ffmpeg.on('error', (err) => {
        reject(new Error(`FFmpeg error: ${err.message}`));
      });
    });
    
    console.log('🎉 Video download and combination completed successfully!');
    
  } catch (error) {
    console.error(`Error during separate streams download: ${error.message}`);
    throw error;
  }
};

const main = async () => {
  // Test network connectivity first
  const isConnected = await testNetworkConnectivity();
  if (!isConnected) {
    console.error('Network connectivity test failed. Please resolve network issues before proceeding.');
    process.exit(1);
  }

  // Check available download tools
  const ffmpegAvailable = await checkFfmpegAvailability();
  const ytDlpAvailable = await checkYtDlpAvailability();
  
  if (!ffmpegAvailable && !ytDlpAvailable) {
    console.error('Neither ffmpeg nor yt-dlp is available. Please install at least one:');
    console.error('ffmpeg: brew install ffmpeg');
    console.error('yt-dlp: pip install yt-dlp or brew install yt-dlp');
    process.exit(1);
  }

  if (!ytDlpAvailable) {
    console.warn('Warning: yt-dlp is not available. This is the most reliable tool for protected content.');
    console.warn('Install with: pip install yt-dlp or brew install yt-dlp');
  }

  if (argv.list) {
    await downloadFromList();
  } else if (argv.url) {
    await downloadSingleFile();
  }
};

main();
