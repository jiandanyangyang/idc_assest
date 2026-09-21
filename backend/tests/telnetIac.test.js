const { stripTelnetIAC } = require('../services/portDiscovery/drivers/telnet');

describe('telnet stripTelnetIAC（IAC 控制序列剥离）', () => {
  it('纯文本原样通过', () => {
    const r = stripTelnetIAC(Buffer.from('<H3C>display version\r\n'), () => {});
    expect(r.text).toBe('<H3C>display version\r\n');
    expect(r.tail.length).toBe(0);
  });

  it('剥离 WILL/DO 协商并触发回调', () => {
    const calls = [];
    const buf = Buffer.from([255, 251, 24]); // IAC WILL NAWS
    const buf2 = Buffer.from([255, 253, 0]); // IAC DO TTYPE(0)
    const r = stripTelnetIAC(Buffer.concat([buf, Buffer.from('Username:'), buf2]), (cmd, opt) => calls.push([cmd, opt]));
    expect(r.text).toBe('Username:');
    expect(calls).toEqual([[251, 24], [253, 0]]);
    expect(r.tail.length).toBe(0);
  });

  it('跨包截断的 IAC 序列进入 tail，与下个包拼接后正确剥离', () => {
    const calls = [];
    // 第一包：文本 + IAC WILL（截断，缺选项字节）
    const r1 = stripTelnetIAC(Buffer.concat([Buffer.from('OK'), Buffer.from([255, 251])]), (c, o) => calls.push([c, o]));
    expect(r1.text).toBe('OK');
    expect(r1.tail).toEqual(Buffer.from([255, 251]));

    // 第二包：选项字节 + 后续文本
    const r2 = stripTelnetIAC(Buffer.concat([r1.tail, Buffer.from([24]), Buffer.from('continue')]), (c, o) => calls.push([c, o]));
    expect(r2.text).toBe('continue');
    expect(calls).toEqual([[251, 24]]);
    expect(r2.tail.length).toBe(0);
  });

  it('丢弃子协商 SB ... SE（含完整到与截断两种情况）', () => {
    // 完整子协商：IAC SB 24 "xterm" IAC SE
    const complete = Buffer.from([255, 250, 24, 120, 116, 255, 240]);
    const r1 = stripTelnetIAC(Buffer.concat([Buffer.from('A'), complete, Buffer.from('B')]), () => {});
    expect(r1.text).toBe('AB');
    expect(r1.tail.length).toBe(0);

    // 截断子协商：等待后续包
    const partial = Buffer.from([255, 250, 24, 120]);
    const r2 = stripTelnetIAC(Buffer.concat([Buffer.from('A'), partial]), () => {});
    expect(r2.text).toBe('A');
    expect(r2.tail).toEqual(partial);
  });

  it('IAC IAC 转义为字面 0xFF 字节', () => {
    const r = stripTelnetIAC(Buffer.from([65, 255, 255, 66]), () => {});
    // 0xFF 非合法 UTF-8 单字节，解码为 U+FFFD 替换符；字节长度不变即转义正确
    expect(r.text).toHaveLength(3);
    expect(r.text[0]).toBe('A');
    expect(r.text[2]).toBe('B');
    expect(r.tail.length).toBe(0);
  });

  it('双字节命令（NOP/GOAHEAD 等）直接丢弃', () => {
    const r = stripTelnetIAC(Buffer.concat([Buffer.from('X'), Buffer.from([255, 241]), Buffer.from([255, 249]), Buffer.from('Y')]), () => {});
    expect(r.text).toBe('XY');
  });

  it('模拟华为设备登录场景：协商 + 登录提示混合到达', () => {
    const calls = [];
    const chunk = Buffer.concat([
      Buffer.from([255, 251, 24, 255, 253, 34, 255, 251, 3]), // WILL NAWS / DO TTYPE? / WILL SGA
      Buffer.from('\r\n\r\nWelcome to Huawei.\r\nLogin:'),
    ]);
    const r = stripTelnetIAC(chunk, (c, o) => calls.push([c, o]));
    expect(r.text).toBe('\r\n\r\nWelcome to Huawei.\r\nLogin:');
    expect(calls).toEqual([[251, 24], [253, 34], [251, 3]]);
  });
});
