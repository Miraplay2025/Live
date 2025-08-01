const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const keyFile = path.join(os.homedir(), '.config', 'rclone', 'rclone.conf');
const input = JSON.parse(fs.readFileSync('input.json', 'utf-8'));

const artefatosDir = path.resolve('artefatos/video_final');
fs.mkdirSync(artefatosDir, { recursive: true });

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

function executarFFmpeg(args) {
  return new Promise((resolve, reject) => {
    console.log(`⚙️ Executando FFmpeg: ffmpeg ${args.join(' ')}`);
    const ffmpeg = spawn('ffmpeg', ['-y', ...args]);
    ffmpeg.stdout.on('data', d => process.stdout.write(d.toString()));
    ffmpeg.stderr.on('data', d => process.stderr.write(d.toString()));
    ffmpeg.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`❌ FFmpeg falhou com código ${code}`));
    });
  });
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
      else reject(new Error('❌ ffprobe falhou'));
    });
  });
}

function baixarArquivo(remoto, destino, reencode = true) {
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
        console.log(`✅ Reencodado: ${destino}`);
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
    '-acodec', 'aac',
    '-b:a', '192k',
    '-ar', '44100',
    '-ac', '2',
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

async function aplicarLogoERodape(entrada, saida, offsetSegundos) {
  const rodapeInicioOriginal = 240;
  const rodapeFimOriginal = 300;

  const tempoInicioRelativo = rodapeInicioOriginal - offsetSegundos;
  const tempoFimRelativo = rodapeFimOriginal - offsetSegundos;

  const duracaoVideo = await obterDuracao(entrada);
  if (tempoFimRelativo <= 0 || tempoInicioRelativo >= duracaoVideo) {
    console.log(`⚠️ Rodapé fora do intervalo da parte "${entrada}", pulando aplicação...`);
    const filtroLogo = `[1:v]scale=-1:120[logo]; [0:v][logo]overlay=W-w-1:15[outv]`;
    const argsLogo = [
      '-i', entrada,
      '-i', 'logo.png',
      '-filter_complex', filtroLogo,
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
    ];
    await executarFFmpeg(argsLogo);
    registrarTemporario(saida);
    return;
  }

  const inicioExibicao = Math.max(tempoInicioRelativo, 0);
  const fimExibicao = Math.min(tempoFimRelativo, duracaoVideo);
  const animDur = 1.5;

  const yRodape = `
    if(lte(t,${inicioExibicao}), NAN,
      if(lt(t,${inicioExibicao + animDur}),
        H - sin((t - ${inicioExibicao})/${animDur} * PI/2)*(h+5),
        if(lt(t,${fimExibicao - animDur}),
          H - h - 5,
          if(lt(t,${fimExibicao}),
            H - h - 5 + sin((t - ${fimExibicao - animDur})/${animDur} * PI/2)*(h+5),
            NAN
          )
        )
      )
    )
  `.replace(/\s+/g, ' ');

  const filtro = `
    [1:v]scale=-1:120[logo];
    [2:v]scale=1280:-1[rodape];
    [0:v][logo]overlay=W-w-1:15[tmp];
    [tmp][rodape]overlay=0:'${yRodape}'[outv]
  `.replace(/\s+/g, ' ');

  const args = [
    '-i', entrada,
    '-i', 'logo.png',
    '-i', 'rodape.png',
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
  ];

  console.log(`🖼️ Aplicando logo e rodapé com animação suave em "${entrada}"`);
  console.log(`📍 Rodapé de ${inicioExibicao.toFixed(2)}s a ${fimExibicao.toFixed(2)}s`);
  await executarFFmpeg(args);
  registrarTemporario(saida);
}

// === EXECUÇÃO PRINCIPAL ===
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

    await aplicarLogoERodape('parte1.mp4', 'parte1_editada.mp4', 0);
    await aplicarLogoERodape('parte2.mp4', 'parte2_editada.mp4', meio);

    const sequencia = [
      'parte1_editada.mp4',
      'video_inicial.mp4',
      'video_miraplay.mp4',
      ...extras,
      'video_inicial.mp4',
      'parte2_editada.mp4',
      'video_final.mp4'
    ].filter(v => fs.existsSync(v));

    const tsList = [];

    console.log('\n📦 Iniciando geração dos arquivos .ts para transmissão...');
    for (const mp4 of sequencia) {
      const tsName = path.basename(mp4).replace(/\.mp4$/, '.ts');
      const tsFullPath = path.join(artefatosDir, tsName);

      console.log(`🎞️ Gerando .ts: ${mp4} → ${tsFullPath}`);
      await executarFFmpeg([
        '-i', mp4,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-ar', '44100',
        '-ac', '2',
        '-bsf:v', 'h264_mp4toannexb',
        '-f', 'mpegts',
        tsFullPath
      ]);

      tsList.push(tsFullPath);
    }

    const tsPathsJson = path.join(artefatosDir, 'ts_paths.json');
    const streamInfoJson = path.join(artefatosDir, 'stream_info.json');

    fs.writeFileSync(tsPathsJson, JSON.stringify(tsList, null, 2));
    fs.writeFileSync(streamInfoJson, JSON.stringify({
      id: input.id,
      stream_url: input.stream_url
    }, null, 2));

    console.log('\n✅ Preparação concluída.');
    console.log(`📄 Arquivos gerados em: ${artefatosDir}`);
    console.log(`🧾 ts_paths.json e stream_info.json criados com sucesso.`);

  } catch (erro) {
    console.error('\n❌ Erro durante o processo:', erro.message);
    process.exit(1);
  } finally {
    limparTemporarios();
  }
})();
