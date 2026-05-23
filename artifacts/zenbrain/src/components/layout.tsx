import { Link } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { BookOpen, LogOut } from "lucide-react";

export function Layout({ children }: { children: React.ReactNode }) {
  const { session, signOut } = useAuth();

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      <header className="sticky top-0 z-50 w-full border-b bg-card/80 backdrop-blur">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 text-primary font-medium text-lg">
            <BookOpen className="w-6 h-6" />
            <span>ZenBrain</span>
          </Link>
          
          {session && (
            <div className="flex items-center gap-4">
              <Button variant="ghost" size="sm" onClick={() => signOut()}>
                <LogOut className="w-4 h-4 mr-2" />
                Sign Out
              </Button>
            </div>
          )}
        </div>
      </header>

      <main className="flex-1 container mx-auto px-4 py-8">
        {children}
      </main>
    </div>
  );
}
