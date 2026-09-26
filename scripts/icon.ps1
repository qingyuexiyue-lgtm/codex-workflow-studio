Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap 64,64
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#203c34'))
$pen = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#b5dcc8')),4
$graphics.DrawLines($pen, [System.Drawing.Point[]]@((New-Object System.Drawing.Point 19,20),(New-Object System.Drawing.Point 19,43),(New-Object System.Drawing.Point 43,43),(New-Object System.Drawing.Point 43,20)))
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#d8efe3'))
$graphics.FillRectangle($brush,12,12,14,14)
$graphics.FillRectangle($brush,36,12,14,14)
$graphics.FillRectangle($brush,36,36,14,14)
$bitmap.Save((Join-Path $PSScriptRoot '../desktop/icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
