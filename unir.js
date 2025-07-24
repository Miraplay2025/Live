const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const keyFile = path.join(os.homedir(), '.config', 'rclone', 'rclone.conf');
const input = JSON.parse(fs.readFileSync('input.json', 'utf-8'));
const arquivosTemporarios = [];
const pastaArtefatos = path.resolve('artefatos'); // caminho absoluto
fs.mkdirSync(pastaArtefatos, { recursive: true });

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
      } catch (e) {
        console.warn(`⚠️ Falha ao remover: ${arq}`);
      }
    }
  }
}

async function executarFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', ['-y', ...args]);
    ffmpeg.stdout.on('data', d => process.stdout.write(d.toString()));
    ffmpeg.stderr.on('data', d => process.stderr.write(d.toString()));
    ffmpeg.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`❌ FFmpeg falhou com código ${code}`));
    });
  });
}

async function obterDuracao(video) {
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
      else reject(new Error('❌ ffprobe falhou'));
    });
  });
}

function formatarTempo(segundos) {
  const m = Math.floor(segundos / 60);
  const s = Math.round(segundos % 60);
  return `${m}m${s}s`;
}

/**
 * Aplica logo e rodapé num vídeo, exibindo rodapé exatamente aos 4 minutos de vídeo original,
 * calculando offset para parte2.
 * 
 * @param {string} entrada Arquivo mp4 de entrada
 * @param {string} saida Arquivo mp4 de saída
 * @param {string} logo Caminho da imagem do logo
 * @param {string} rodape Caminho da imagem do rodapé
 * @param {number} duracaoParte1 Duração da parte1 (em segundos) para cálculo do offset da parte2
 * @param {boolean} isParte2 Se o vídeo é a parte2, aplica offset no tempo do rodapé
 */
async function aplicarLogoERodape(entrada, saida, logo, rodape, duracaoParte1, isParte2 = false) {
  const tempoRodape = 240; // 4 minutos em segundos
  let rodapeInicio = tempoRodape;
  if (isParte2) {
    // para parte2 o rodapé deve começar em (240 - duração da parte1)
    rodapeInicio = tempoRodape - duracaoParte1;
    if (rodapeInicio < 0) rodapeInicio = 0; // garantir que não seja negativo
  }
  const rodapeFim = rodapeInicio + 10;

  console.log(`🖼️ Aplicando logo e rodapé em ${entrada}`);
  console.log(`   Rodapé aparece entre ${formatarTempo(rodapeInicio)} e ${formatarTempo(rodapeFim)}`);

  const filtro = `
    [1:v]scale=-1:120[logo];
    [2:v]scale=1280:-1[rodape];
    [0:v]setpts=PTS-STARTPTS[base];
    [base][logo]overlay=x=W-w-15:y=15[comlogo];
    [comlogo][rodape]overlay=enable='between(t,${rodapeInicio},${rodapeFim})':x=0:y=H-h[outv]
  `.replace(/\n/g, '').replace(/\s+/g, ' ').trim();

  await executarFFmpeg([
    '-i', entrada,
    '-i', logo,
    '-i', rodape,
    '-filter_complex', filtro,
    '-map', '[outv]',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-acodec', 'aac',
    '-b:a', '192k',
    '-ar', '44100',
    '-ac', '2',
    '-r', '30',
    saida
  ]);
  registrarTemporario(saida);
}

(async () => {
  try {
    console.log('🚀 Iniciando preparação da live...');

    await baixarArquivo(input.video_principal, 'video_principal.mp4');
    await baixarArquivo(input.logo_id, 'logo.png', false);
    await baixarArquivo(input.rodape_id, 'rodape.png', false);

    if (input.video_inicial) await baixarArquivo(input.video_inicial, 'video_inicial.mp4');
    if (input.video_miraplay) await baixarArquivo(input.video_miraplay, 'video_miraplay.mp4');
    if (input.video_final) await baixarArquivo(input.video_final, 'video_final.mp4');

    const extras = [];
    for (let i = 0; i < input.videos_extras.length; i++) {
      const nome = `extra${i + 1}.mp4`;
      await baixarArquivo(input.videos_extras[i], nome);
      extras.push(nome);
    }

    const duracaoPrincipal = await obterDuracao('video_principal.mp4');
    const meio = duracaoPrincipal / 2;
    await cortarVideo('video_principal.mp4', 'parte1.mp4', 'parte2.mp4', meio);

    const duracaoParte1 = await obterDuracao('parte1.mp4');
    const duracaoParte2 = await obterDuracao('parte2.mp4');

    await aplicarLogoERodape('parte1.mp4', 'parte1_editada.mp4', 'logo.png', 'rodape.png', duracaoParte1, false);
    await aplicarLogoERodape('parte2.mp4', 'parte2_editada.mp4', 'logo.png', 'rodape.png', duracaoParte1, true);

    const sequencia = [
      'parte1_editada.mp4',
      'video_inicial.mp4',
      'video_miraplay.mp4',
      ...extras,
      'video_inicial.mp4',
      'parte2_editada.mp4',
      'video_final.mp4'
    ].filter(v => fs.existsSync(v));

    let tempoTotal = 0;
    const tsList = [];

    for (const arq of sequencia) {
      const tsName = path.join(pastaArtefatos, arq.replace(/\.mp4$/, '.ts'));
      const duracao = await obterDuracao(arq);
      tempoTotal += duracao;

      console.log(`🎞️ Embutindo vídeo completo: ${arq}`);
      await executarFFmpeg([
        '-i', arq,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-ar', '44100',
        '-ac', '2',
        '-bsf:v', 'h264_mp4toannexb',
        '-f', 'mpegts',
        tsName
      ]);

      tsList.push(tsName);
    }

    // Salvar artefatos com caminhos absolutos
    const streamInfo = {
      stream_url: input.stream_url,
      gerado_em: new Date().toISOString(),
      duracao_total_segundos: tempoTotal,
      arquivos: tsList
    };

    fs.writeFileSync(path.join(pastaArtefatos, 'stream_info.json'), JSON.stringify(streamInfo, null, 2));
    fs.writeFileSync(path.join(pastaArtefatos, 'sequencia_da_transmissao.txt'), tsList.join('\n'));

    console.log(`\n✅ Artefatos com caminhos absolutos salvos em: ${pastaArtefatos}`);
    console.log(`⏱️ Duração estimada: ${formatarTempo(tempoTotal)}\n`);
  } catch (erro) {
    console.error('\n❌ Erro durante o processo:', erro.message);
  } finally {
    limparTemporarios();
  }
})();
