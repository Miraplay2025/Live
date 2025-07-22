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
    console.log('📂 Verificando arquivos essenciais...');

    if (!fs.existsSync('stream_info.json')) {
      throw new Error('Arquivo stream_info.json não encontrado.');
    }

    if (!fs.existsSync('sequencia_da_transmissao.txt')) {
      throw new Error('Arquivo sequencia_da_transmissao.txt não encontrado.');
    }

    const streamInfo = JSON.parse(fs.readFileSync('stream_info.json', 'utf-8'));
    const streamUrl = streamInfo.stream_url;

    if (!streamUrl) {
      throw new Error('URL de transmissão (stream_url) não encontrada no stream_info.json.');
    }

    console.log(`🌐 URL de transmissão: ${streamUrl}`);

    // Lê e processa sequência de vídeos
    console.log('\n📑 Lendo sequencia_da_transmissao.txt...');
    const sequenciaRaw = fs.readFileSync('sequencia_da_transmissao.txt', 'utf-8');

    const linhas = sequenciaRaw
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith("file '") && l.endsWith("'"));

    const videos = linhas.map(l => {
      const arquivo = l.slice(6, -1); // remove "file '" do início e "'" do final
      return arquivo.trim();
    });

    if (videos.length === 0) {
      throw new Error('Nenhum vídeo válido encontrado na sequência.');
    }

    console.log(`📦 Arquivos encontrados na sequência (${videos.length}):`);
    videos.forEach(v => console.log(`🧩 ${v}`));

    // Registra vídeos como temporários
    videos.forEach(v => registrarTemporario(v));

    // Também registra imagens para limpeza
    if (fs.existsSync('logo.png')) {
      registrarTemporario('logo.png');
      console.log('🖼️ logo.png adicionado para limpeza.');
    }

    if (fs.existsSync('rodape.png')) {
      registrarTemporario('rodape.png');
      console.log('🖼️ rodape.png adicionado para limpeza.');
    }

    // FFmpeg para transmissão
    console.log('\n🎥 Iniciando transmissão via FFmpeg...');
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
      console.error('❌ Erro ao executar FFmpeg:', err);
      limparTemporarios();
      process.exit(1);
    });

    ffmpeg.on('close', code => {
      if (code === 0) {
        console.log('\n✅ Transmissão finalizada com sucesso!');
      } else {
        console.error(`\n❌ FFmpeg finalizou com erro (código ${code}).`);
      }
      limparTemporarios();
      process.exit(code);
    });

  } catch (err) {
    console.error('\n❌ Erro fatal:', err.message);
    limparTemporarios();
    process.exit(1);
  }
})();
