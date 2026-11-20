const illustrations = "/illustrations";

/** A responsive illustration: AVIF first, WebP as the fallback, at the widths built for it. */
export function Illustration({
  name,
  widths,
  sizes,
  alt,
  width,
  height,
  eager = false,
}: {
  readonly name: string;
  readonly widths: readonly number[];
  readonly sizes: string;
  readonly alt: string;
  readonly width: number;
  readonly height: number;
  readonly eager?: boolean;
}) {
  const srcSet = (format: "avif" | "webp") =>
    widths.map((size) => `${illustrations}/${name}-${size}.${format} ${size}w`).join(", ");
  return (
    <picture>
      <source type="image/avif" srcSet={srcSet("avif")} sizes={sizes} />
      <img
        src={`${illustrations}/${name}-${widths[0]}.webp`}
        srcSet={srcSet("webp")}
        sizes={sizes}
        alt={alt}
        width={width}
        height={height}
        loading={eager === true ? "eager" : "lazy"}
        decoding="async"
      />
    </picture>
  );
}
