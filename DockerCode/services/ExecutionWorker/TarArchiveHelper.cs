using System.Text;

public static class TarArchiveHelper
{
    private const int BlockSize = 512;

    public static byte[] Create(IReadOnlyDictionary<string, byte[]> files)
    {
        using var stream = new MemoryStream();

        foreach (var (name, data) in files)
        {
            WriteFile(stream, name.Replace('\\', '/'), data);
        }

        stream.Write(new byte[BlockSize * 2]);
        return stream.ToArray();
    }

    private static void WriteFile(Stream stream, string name, byte[] data)
    {
        if (Encoding.UTF8.GetByteCount(name) > 100)
            throw new InvalidOperationException($"Nome muito longo para o TAR simples: {name}");

        var header = new byte[BlockSize];
        WriteString(header, 0, 100, name);
        WriteOctal(header, 100, 8, 0x1A4); // 0644
        WriteOctal(header, 108, 8, 0);
        WriteOctal(header, 116, 8, 0);
        WriteOctal(header, 124, 12, data.LongLength);
        WriteOctal(header, 136, 12, DateTimeOffset.UtcNow.ToUnixTimeSeconds());

        for (var i = 148; i < 156; i++) header[i] = 0x20;
        header[156] = (byte)'0';
        WriteString(header, 257, 6, "ustar");
        WriteString(header, 263, 2, "00");

        var checksum = header.Sum(value => (int)value);
        var checksumText = Convert.ToString(checksum, 8)!.PadLeft(6, '0');
        WriteString(header, 148, 6, checksumText);
        header[154] = 0;
        header[155] = 0x20;

        stream.Write(header);
        stream.Write(data);

        var remainder = data.Length % BlockSize;
        if (remainder != 0) stream.Write(new byte[BlockSize - remainder]);
    }

    private static void WriteString(byte[] buffer, int offset, int length, string value)
    {
        var bytes = Encoding.ASCII.GetBytes(value);
        Array.Copy(bytes, 0, buffer, offset, Math.Min(length, bytes.Length));
    }

    private static void WriteOctal(byte[] buffer, int offset, int length, long value)
    {
        var text = Convert.ToString(value, 8)!.PadLeft(length - 1, '0');
        WriteString(buffer, offset, length - 1, text[^Math.Min(text.Length, length - 1)..]);
        buffer[offset + length - 1] = 0;
    }
}
