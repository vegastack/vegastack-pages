type Props = {
  className?: string;
  title?: string;
};

export function VegaStackMark({ className, title = "VegaStack" }: Props) {
  return (
    <svg
      className={className}
      viewBox="0 0 60 60"
      role="img"
      aria-label={title}
      focusable="false"
    >
      <path
        fill="currentColor"
        d="M38.74,3.23l-6,10.46c0,0,3.83,0,5.29,0c1.46,0,1.31,1.01,0.52,2.14c-0.83,1.12-12.82,17.14-13.69,18.11c-0.86,0.98-1.99,1.16-1.2-1.12s4.46-12.64,4.46-12.64s-5.4,0-6.34,0c-0.98,0-0.75-0.52-0.41-1.24s7.69-15.71,7.69-15.71s-19.76,0-23.02,0S0,5.33,0,8.74s1.61,5.59,2.66,7.61s17.44,30.3,19.42,33.97s4.05,6.45,7.76,6.45s5.25-1.58,8.25-6.83s18.04-31.16,19.76-34.39c1.73-3.23,2.14-4.2,2.14-6.45s-1.76-5.89-7.24-5.89S38.74,3.23,38.74,3.23z"
      />
    </svg>
  );
}
