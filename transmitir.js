const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

const artefatosDir = path.resolve('artefatos/video_final');
const tsList = JSON.parse(fs.readFileSync(path.join(artefatosDir, 'ts_paths.json'), 'utf-8'));
const streamInfo = JSON.parse(fs.readFileSync(path.join(artefatosDir, 'stream_info.json'), 'utf-8'));

function formatarTempo(segundos) {
  const m = Math.floor(segundos / 60);
  const s = Math.round(segundos % 60);
  return `${m}m${s}s`;
}

function obterDuracao(video) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      video
    ]);
    let output = '';
    ffprobe.stdout.on('data', chunk => output += chunk.toString());
    ffprobe.on('close', code => {
      if (code === 0) resolve(parseFloat(output.trim()));
      else reject(new Error(`❌ ffprobe falhou para arquivo: ${video}`));
    });
  });
}

function limparArtefatos() {
  console.log('\n🧹 Limpando arquivos em artefatos/video_final...');
  if (!fs.existsSync(artefatosDir)) return;
  const arquivos = fs.readdirSync(artefatosDir);
  for (const arquivo of arquivos) {
    const caminho = path.join(artefatosDir, arquivo);
    try {
      fs.unlinkSync(caminho);
      console.log(`🗑️ Removido: ${caminho}`);
    } catch (err) {
      console.warn(`⚠️ Falha ao remover: ${caminho} - ${err.message}`);
    }
  }
}

(async () => {
  try {
    console.log('🚀 Iniciando transmissão...');
    console.log(`🆔 ID da live: ${streamInfo.id}`);
    console.log(`📡 URL da stream: ${streamInfo.stream_url}`);
    console.log('🎬 Vídeos a transmitir:');
    tsList.forEach(v => console.log(`  - ${v}`));

    // Obter duração total somando durações dos arquivos .ts
    let duracaoTotal = 0;
    for (const arquivo of tsList) {
      const duracao = await obterDuracao(arquivo);
      console.log(`⏱️ Duração de ${path.basename(arquivo)}: ${formatarTempo(duracao)}`);
      duracaoTotal += duracao;
    }
    console.log(`\n⏳ Duração total estimada da live: ${formatarTempo(duracaoTotal)}\n`);

    const concatStr = `concat:${tsList.join('|')}`;
    console.log(`📡 Conectando ao servidor de streaming e iniciando transmissão...`);

    const ffmpeg = spawn('ffmpeg', [
      '-re',
      '-i', concatStr,
      '-c', 'copy',
      '-f', 'flv',
      streamInfo.stream_url
    ]);

    let tempoDecorrido = 0;
    const intervalo = setInterval(() => {
      tempoDecorrido++;
      const restante = duracaoTotal - tempoDecorrido;
      if (restante >= 0) {
        process.stdout.write(`\r⏳ Tempo restante da live: ${formatarTempo(restante)}   `);
      }
    }, 1000);

    ffmpeg.stdout.on('data', d => process.stdout.write(d.toString()));
    ffmpeg.stderr.on('data', d => process.stderr.write(d.toString()));

    await new Promise((resolve, reject) => {
      ffmpeg.on('close', code => {
        clearInterval(intervalo);
        process.stdout.write('\n');
        limparArtefatos();
        if (code === 0) {
          console.log('✅ Transmissão finalizada com sucesso!');
          resolve();
        } else {
          console.error(`❌ Falha na transmissão. Código: ${code}`);
          reject(new Error(`FFmpeg falhou com código ${code}`));
        }
      });
    });
  } catch (erro) {
    console.error(`\n❌ Erro: ${erro.message}`);
    limparArtefatos();
    process.exit(1);
  }
})();
