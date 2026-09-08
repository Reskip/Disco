import Link from 'next/link';

// Navbar "Disco Cloud" entry: links to the Disco Cloud landing page (/cloud)
// instead of popping the beta modal. The request-invite form now lives behind
// the CTAs on that page. Rendered as <Navbar> children; styles.css slots it
// left of the search input via flex order (`.navbar-cloud-cta`), including an
// anchor-specific override so switching from <button> to <a> keeps its place.
export function NavbarCloudCTA() {
  return (
    <Link href="/cloud" className="navbar-cloud-cta">
      Disco Cloud
    </Link>
  );
}
