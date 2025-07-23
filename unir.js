const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

const keyFile = path.join(os.homedir(), '.config', 'rclone', 'rclone.conf');
const input = JSON.parse(fs.readFileSync('input.json', 'utf-8'));
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

async function baixarArquivo(remoto, destino, reencode = true) {
  return new Promise((resolve, reject) => {
    console.log(`⬇️ Baixando: ${remoto}`);
    const rclone = spawn('rclone', ['copy', `meudrive:${remoto}`, '.', '--config', keyFile]);
    rclone.stderr.on('data', d => process.stderr.write(d.toString()));
    rclone.on('close', async code => {
      if (code !== 0) return reject(new Error(`Erro ao baixar ${remoto}`));
      const base = path.basename(remoto);
      if (!fs.existsSync(base)) return reject(new Error(`Arquivo não encontrado: ${base}`));
      fs.renameSync(base, destino);
      console.log(`✅ Baixado e renomeado: ${destino}`);
      if (reencode) {
        const temp = destino.replace(/(\.[^.]+)$/, '_temp$1');
        await reencodeVideo(destino, temp);
        fs.renameSync(temp, destino);
      }
      registrarTemporario(destino);
      resolve();
    });
  });
}

async function reencodeVideo(input, output) {
  console.log(`🔄 Reencodando ${input} → ${output}`);
  await executarFFmpeg([
    '-i', input,
    '-vf', 'scale=1280:720,fps=30',
    '-r', '30',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    output
  ]);
  registrarTemporario(output);
}

async function cortarVideo(input, out1, out2, meio) {
  console.log(`✂️ Cortando vídeo ${input}...`);
  await executarFFmpeg(['-i', input, '-t', meio.toString(), '-c', 'copy', out1]);
  await executarFFmpeg(['-i', input, '-ss', meio.toString(), '-c', 'copy', out2]);
  registrarTemporario(out1);
  registrarTemporario(out2);
}

async function aplicarLogoERodape(entrada, saida, logo, rodape) {
  console.log(`🖼️ Aplicando logo e rodapé em ${entrada}`);
  const filtro = `
    [1:v]scale=120:120[logo];
    [2:v]scale=w=iw:h=iw*9/16[rodape];
    [0:v]setpts=PTS-STARTPTS[base];
    [base][logo]overlay=W-w-15:15[comlogo];
    [comlogo][rodape]overlay=enable='between(t,240,250)':x=(W-w)/2:y=H-h[outv]
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
    '-c:a', 'aac',
    '-r', '30',
    saida
  ]);
  registrarTemporario(saida);
}

async function transmitirSequenciaIndividualmente(sequencia, streamUrl) {
  console.log(`📡 Iniciando transmissão por sequência para: ${streamUrl}`);

  for (const arquivo of sequencia) {
    if (!fs.existsSync(arquivo)) continue;
    console.log(`\n🎬 Transmitindo: ${arquivo}`);
    await new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', [
        '-re', '-i', arquivo,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-b:v', '900k',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '44100',
        '-r', '30',
        '-f', 'flv',
        '-flvflags', 'no_duration_filesize',
        streamUrl
      ], { stdio: 'inherit' });

      ffmpeg.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`Erro ao transmitir ${arquivo}`));
      });
    });
  }

  console.log('\n✅ Live finalizada com todos os vídeos transmitidos!');
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
    await aplicarLogoERodape('parte1.mp4', 'parte1_editada.mp4', 'logo.png', 'rodape.png');
    await aplicarLogoERodape('parte2.mp4', 'parte2_editada.mp4', 'logo.png', 'rodape.png');

    const sequencia = [
      'parte1_editada.mp4',
      'video_inicial.mp4',
      'video_miraplay.mp4',
      'video_inicial.mp4',
      'parte2_editada.mp4',
      'video_final.mp4',
      ...extras
    ].filter(v => fs.existsSync(v));

    const tempos = {};
    let tempoTotal = 0;

    for (const arquivo of sequencia) {
      const duracao = await obterDuracao(arquivo);
      tempos[arquivo] = duracao;
      tempoTotal += duracao;
    }

    console.log('\n🕒 Duração dos vídeos na sequência da transmissão:');
    for (const [nome, duracao] of Object.entries(tempos)) {
      console.log(`🧩 ${nome} → ${formatarTempo(duracao)}`);
    }

    console.log(`\n⏱️ Tempo total da live: ${formatarTempo(tempoTotal)}\n`);

    fs.writeFileSync('sequencia_da_transmissao.txt', sequencia.join('\n'));
    console.log('📄 Arquivo "sequencia_da_transmissao.txt" criado.');

    await transmitirSequenciaIndividualmente(sequencia, input.stream_url);

  } catch (erro) {
    console.error('\n❌ Erro durante o processo:', erro.message);
  } finally {
    limparTemporarios();
  }
})();
