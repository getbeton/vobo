import { Button, Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from 'vobo';

export const Default = () => (
  <Card style={{ width: 380 }}>
    <CardHeader>
      <CardTitle>Road maintenance, Northern region</CardTitle>
      <CardDescription>Ministry of Transport · published 14 Sep 2026</CardDescription>
      <CardAction>
        <Button variant="outline" size="sm">Save</Button>
      </CardAction>
    </CardHeader>
    <CardContent>
      <p className="text-sm text-muted-foreground">
        Resurfacing and drainage works on 42 km of regional roads. Open to registered contractors.
      </p>
    </CardContent>
    <CardFooter className="justify-between">
      <span className="font-mono text-sm">$1,240,000</span>
      <Button size="sm">View tender</Button>
    </CardFooter>
  </Card>
);

export const Stat = () => (
  <Card style={{ width: 240 }}>
    <CardHeader>
      <CardDescription>Awards this month</CardDescription>
      <CardTitle className="text-3xl font-semibold">1,284</CardTitle>
    </CardHeader>
    <CardContent>
      <p className="text-sm text-muted-foreground">+12% vs August</p>
    </CardContent>
  </Card>
);
