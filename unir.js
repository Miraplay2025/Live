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
    saida
  ]);
  registrarTemporario(saida);
}

async function transmitirSequencia(sequencia, streamUrl) {
  console.log(`📡 Iniciando transmissão contínua para: ${streamUrl}`);
  const args = [];

  for (const file of sequencia) {
    args.push('-re', '-i', file);
  }

  const filter = `concat=n=${sequencia.length}:v=1:a=1[outv][outa]`;

  const finalArgs = [
    ...args,
    '-filter_complex', filter,
    '-map', '[outv]',
    '-map', '[outa]',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-c:a', 'aac',
    '-f', 'flv',
    streamUrl
  ];

  const ffmpeg = spawn('ffmpeg', finalArgs, { stdio: 'inherit' });

  return new Promise((resolve, reject) => {
    ffmpeg.on('close', code => {
      if (code === 0) {
        console.log('\n✅ Transmissão finalizada com sucesso!');
        resolve();
      } else {
        reject(new Error(`Erro na transmissão. Código: ${code}`));
      }
    });
  });
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

    const duracao = await obterDuracao('video_principal.mp4');
    const meio = duracao / 2;
    await cortarVideo('video_principal.mp4', 'parte1.mp4', 'parte2.mp4', meio);

    await aplicarLogoERodape('parte1.mp4', 'parte1_editada.mp4', 'logo.png', 'rodape.png');
    await aplicarLogoERodape('parte2.mp4', 'parte2_editada.mp4', 'logo.png', 'rodape.png');

    const sequencia = [];
    sequencia.push('parte1_editada.mp4');
    if (fs.existsSync('video_inicial.mp4')) sequencia.push('video_inicial.mp4');
    if (fs.existsSync('video_miraplay.mp4')) sequencia.push('video_miraplay.mp4');
    extras.forEach(v => sequencia.push(v));
    if (fs.existsSync('video_inicial.mp4')) sequencia.push('video_inicial.mp4');
    sequencia.push('parte2_editada.mp4');
    if (fs.existsSync('video_final.mp4')) sequencia.push('video_final.mp4');

    fs.writeFileSync('sequencia_da_transmissao.txt', sequencia.join('\n'));
    console.log('📄 Arquivo "sequencia_da_transmissao.txt" criado.');

    await transmitirSequencia(sequencia, input.stream_url);

  } catch (erro) {
    console.error('\n❌ Erro durante o processo:', erro.message);
  } finally {
    limparTemporarios();
  }
})();
