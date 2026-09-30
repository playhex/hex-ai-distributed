/*
 * Fake GTP engine for GTPClient tests.
 *
 * Commands:
 *  echo <text>   => "= <text>", sent in multiple chunks
 *  multiline     => "= line1\nline2"
 *  fail          => "? failed"
 *  sleep         => never answers
 *  crash         => exits
 */
const send = text => process.stdout.write(text);

let buffer = '';

process.stdin.on('data', data => {
    buffer += data.toString();

    let end;

    while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.substring(0, end).trim();
        buffer = buffer.substring(end + 1);

        const [command, ...args] = line.split(' ');

        switch (command) {
            case 'echo': {
                const response = `= ${args.join(' ')}\n\n`;
                send(response.substring(0, 3));
                setTimeout(() => send(response.substring(3)), 30);
                break;
            }

            case 'multiline': send('= line1\nline2\n\n'); break;
            case 'fail': send('? failed\n\n'); break;
            case 'sleep': break;
            case 'crash': process.exit(3);
        }
    }
});
