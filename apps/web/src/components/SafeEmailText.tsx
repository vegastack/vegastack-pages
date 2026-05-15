type SafeEmailTextProps = {
  email: string;
  className?: string;
};

export function SafeEmailText({ email, className }: SafeEmailTextProps) {
  const atIndex = email.indexOf("@");
  const local = atIndex > 0 ? email.slice(0, atIndex) : email;
  const domain = atIndex > 0 ? email.slice(atIndex + 1) : "";

  if (!domain) {
    return <span className={className}>{email}</span>;
  }

  return (
    <span className={className} aria-label={email}>
      <span aria-hidden="true">{local}</span>
      <span aria-hidden="true">@</span>
      <span aria-hidden="true">{domain}</span>
    </span>
  );
}
