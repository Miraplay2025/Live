const fs = require('fs');
const { spawn } = require('child_process');

const arquivosTemporarios = [];

function registrarTemporario(caminho) {
  arquivosTemporarios.push(caminho);
}

function limparTemporarios() {
  console.log('\n🧹 Limpando arquivos temporários...');
  for (const arq of arquivosTemporarios) {
    if (fs.existsSync(arq)) {
      try {
        fs.unlinkSync(arq);
        console.log(`🗑️ Removido: ${arq}`);
      } catch (err) {
        console.error(`❌ Erro ao remover arquivo ${arq}:`, err);
      }
    }
  }
}

(async () => {
  try {
    // Verifica arquivos essenciais
    if (!fs.existsSync('stream_info.json') || !fs.existsSync('sequencia_da_transmissao.txt')) {
      throw new Error('Arquivos stream_info.json ou sequencia_da_transmissao.txt não encontrados.');
    }

    const streamInfo = JSON.parse(fs.readFileSync('stream_info.json', 'utf-8'));
    const streamUrl = streamInfo.stream_url;

    if (!streamUrl) {
      throw new Error('URL de transmissão (stream_url) não encontrado no stream_info.json');
    }

    console.log(`🌐 URL de transmissão: ${streamUrl}`);

    // Lê lista sequencial e registra arquivos para limpeza
    const sequenciaRaw = fs.readFileSync('sequencia_da_transmissao.txt', 'utf-8');
    const linhas = sequenciaRaw.split('\n').map(l => l.trim()).filter(l => l && l.startsWith('file '));
    const videos = linhas.map(l => {
      const match = l.match(/file\s+'([^']+)'/);
      return match ? match[1] : null;
    }).filter(Boolean);

    if (videos.length === 0) {
      throw new Error('Nenhum vídeo encontrado na sequência para transmitir.');
    }

    videos.forEach(v => registrarTemporario(v));

    // Também registra imagens baixadas para limpar
    if (fs.existsSync('logo.png')) registrarTemporario('logo.png');
    if (fs.existsSync('rodape.png')) registrarTemporario('rodape.png');

    // Monta args do FFmpeg para transmissão única concatenada
    console.log('\n▶️ Iniciando transmissão única concatenada de todos os vídeos.');

    const ffmpegArgs = [
      '-re',
      '-f', 'concat',
      '-safe', '0',
      '-i', 'sequencia_da_transmissao.txt',
      '-vf', "scale=w=1280:h=720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2",
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-maxrate', '3000k',
      '-bufsize', '6000k',
      '-pix_fmt', 'yuv420p',
      '-g', '50',
      '-c:a', 'aac',
      '-b:a', '160k',
      '-ar', '44100',
      '-f', 'flv',
      streamUrl
    ];

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    ffmpeg.stderr.on('data', data => {
      process.stderr.write(data.toString());
    });

    ffmpeg.on('error', err => {
      console.error('❌ Erro no FFmpeg:', err);
      limparTemporarios();
      process.exit(1);
    });

    ffmpeg.on('close', code => {
      if (code === 0) {
        console.log('\n✅ Transmissão concluída com sucesso.');
      } else {
        console.error(`\n❌ FFmpeg finalizou com código ${code}.`);
      }
      limparTemporarios();
      process.exit(code);
    });

  } catch (err) {
    console.error('❌ Erro fatal durante a transmissão:', err);
    limparTemporarios();
    process.exit(1);
  }
})();
