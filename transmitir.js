const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

const pastaArtefatos = path.resolve('artefatos');

function executarFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    proc.stdout.on('data', d => process.stdout.write(d.toString()));
    proc.stderr.on('data', d => process.stderr.write(d.toString()));
    proc.on('close', code => {
      code === 0 ? resolve() : reject(new Error(`FFmpeg falhou com código ${code}`));
    });
    proc.on('error', err => reject(err));
  });
}

function formatarTempo(segundos) {
  const m = Math.floor(segundos / 60);
  const s = Math.round(segundos % 60);
  return `${m}m${s}s`;
}

function limparArtefatos() {
  if (!fs.existsSync(pastaArtefatos)) return;
  const arquivos = fs.readdirSync(pastaArtefatos);
  for (const arquivo of arquivos) {
    try {
      const caminho = path.join(pastaArtefatos, arquivo);
      fs.unlinkSync(caminho);
      console.log(`🗑️ Removido artefato: ${caminho}`);
    } catch (e) {
      console.warn(`⚠️ Falha ao remover artefato: ${arquivo}`, e.message);
    }
  }
}

(async () => {
  try {
    const infoPath = path.join(pastaArtefatos, 'stream_info.json');
    const listaPath = path.join(pastaArtefatos, 'sequencia_da_transmissao.txt');

    if (!fs.existsSync(infoPath) || !fs.existsSync(listaPath)) {
      throw new Error('Arquivos de artefatos não encontrados na pasta ' + pastaArtefatos);
    }

    const info = JSON.parse(fs.readFileSync(infoPath, 'utf-8'));
    const arquivos = fs.readFileSync(listaPath, 'utf-8')
      .split('\n')
      .map(f => f.trim())
      .filter(Boolean)
      .map(f => path.isAbsolute(f) ? f : path.join(pastaArtefatos, f));

    if (arquivos.length === 0) {
      throw new Error('Nenhum arquivo de vídeo encontrado para transmitir.');
    }

    const streamUrl = info.stream_url;
    const tempoTotal = info.duracao_total_segundos || 0;

    console.log('📋 Dados do artefato:');
    console.log(`  URL da transmissão: ${streamUrl}`);
    console.log(`  Arquivos para transmissão: ${arquivos.length}`);
    arquivos.forEach((a, i) => console.log(`   ${i+1}. ${a}`));
    console.log(`  Duração total estimada: ${formatarTempo(tempoTotal)}`);

    // Concatenação dos arquivos ts para entrada do ffmpeg
    const concatStr = `concat:${arquivos.join('|')}`;

    console.log(`\n📡 Iniciando transmissão para: ${streamUrl}`);
    const ffmpeg = spawn('ffmpeg', [
      '-re',
      '-i', concatStr,
      '-c', 'copy',
      '-f', 'flv',
      streamUrl
    ]);

    let tempoDecorrido = 0;
    const intervalo = setInterval(() => {
      tempoDecorrido++;
      const restante = tempoTotal - tempoDecorrido;
      if (restante >= 0) {
        process.stdout.write(`\r⏳ Tempo restante da live: ${formatarTempo(restante)}   `);
      }
    }, 1000);

    ffmpeg.stderr.on('data', d => process.stderr.write(d.toString()));
    ffmpeg.stdout.on('data', d => process.stdout.write(d.toString()));

    ffmpeg.on('close', code => {
      clearInterval(intervalo);
      if (code === 0) {
        console.log('\n✅ Live finalizada com sucesso!');
      } else {
        console.error(`\n❌ Transmissão encerrada com erro (código ${code})`);
      }
      limparArtefatos();
      process.exit(code);
    });

    ffmpeg.on('error', err => {
      clearInterval(intervalo);
      console.error('\n❌ Falha ao iniciar FFmpeg:', err.message);
      limparArtefatos();
      process.exit(1);
    });

  } catch (e) {
    console.error('❌ Erro:', e.message);
    limparArtefatos();
    process.exit(1);
  }
})();
