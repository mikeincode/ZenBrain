import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BookOpen } from "lucide-react";

export default function AuthPage() {
  const { signIn, signUp } = useAuth();
  const [, setLocation] = useLocation();
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    
    try {
      const { error } = isLogin 
        ? await signIn({ email, password })
        : await signUp({ email, password });
        
      if (error) throw error;
      setLocation("/");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-md shadow-xl border-border/50">
        <CardHeader className="space-y-3 items-center text-center">
          <div className="w-12 h-12 bg-primary/10 rounded-2xl flex items-center justify-center mb-2">
            <BookOpen className="w-6 h-6 text-primary" />
          </div>
          <CardTitle className="text-2xl">Welcome to ZenBrain</CardTitle>
          <CardDescription>
            Your private, searchable vault for AI conversations.
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">
            {error && (
              <div className="p-3 text-sm text-destructive bg-destructive/10 rounded-md">
                {error}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input 
                id="email" 
                type="email" 
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input 
                id="password" 
                type="password" 
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
          </CardContent>
          <CardFooter className="flex flex-col space-y-4">
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Please wait..." : (isLogin ? "Sign In" : "Create Account")}
            </Button>
            <Button 
              type="button" 
              variant="ghost" 
              className="text-muted-foreground"
              onClick={() => setIsLogin(!isLogin)}
            >
              {isLogin ? "Need an account? Sign up" : "Already have an account? Sign in"}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
