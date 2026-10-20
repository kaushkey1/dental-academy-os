from pathlib import Path
import json, math, shutil
from xml.sax.saxutils import escape
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor, white
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Paragraph
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
ROOT=Path(__file__).resolve().parents[2]
D=json.loads((Path(__file__).parent/'course.json').read_text())
OUT=ROOT/'output/pdf/photography-portfolio-workbook.pdf';OUT.parent.mkdir(parents=True,exist_ok=True)
for name,file in [('Body','DejaVuSans.ttf'),('Bold','DejaVuSans-Bold.ttf')]:pdfmetrics.registerFont(TTFont(name,str(ROOT/'assets/fonts'/file)))
W,H=595.28,841.89;M=44;CW=W-M*2
INK=HexColor('#162c48');BLUE=HexColor('#245bd5');TEAL=HexColor('#137d7a');PALE=HexColor('#edf3fc');MUTED=HexColor('#53647b');LINE=HexColor('#d8e2ee');RED=HexColor('#c0543e')
c=canvas.Canvas(str(OUT),pagesize=(W,H),invariant=1);c.setTitle('From First Frame to Portfolio - Field Guide and Practice Workbook');c.setAuthor('Academy OS - demonstration learning edition')
styles={name:ParagraphStyle(name,fontName='Bold' if name in ['h','label'] else 'Body',fontSize=size,leading=leading,textColor=INK) for name,size,leading in [('body',10,16),('small',8,12),('h',25,31),('label',10,15)]}
def text(s,x,y,w=CW,style='body',color=None):
    st=styles[style]
    if color: st=ParagraphStyle('custom',parent=st,textColor=color)
    p=Paragraph(s,st);_,height=p.wrap(w,700)
    assert y-height>45, f'Page overflow: {s[:55]}'
    p.drawOn(c,x,y-height);return y-height

def footer():
    c.setStrokeColor(LINE);c.line(M,39,W-M,39);c.setFont('Body',8);c.setFillColor(HexColor('#9dbdff') if c.getPageNumber()==1 else MUTED);c.drawString(M,25,'MODEL-BASED PRACTICE  /  DEMONSTRATION EDITION');c.drawRightString(W-M,25,f'{c.getPageNumber():02d} / 16')
def page(section,title,subtitle):
    if c.getPageNumber()>1:pass
    c.setFillColor(BLUE);c.rect(0,H-8,W,8,fill=1,stroke=0)
    text(section.upper(),M,H-42,style='label',color=BLUE)
    y=text(title,M,H-78,style='h');return text(subtitle,M,y-14,style='body',color=MUTED)-26
def end():footer();c.showPage()
def rule(y):c.setStrokeColor(LINE);c.line(M,y,W-M,y)
def box(x,y,w,h,fill=PALE):c.setFillColor(fill);c.roundRect(x,y-h,w,h,10,fill=1,stroke=0)
def lines(y,n=3,step=25,label=None):
    if label:y=text(label,M,y,style='label')-12
    for _ in range(n):rule(y);y-=step
    return y

def callout(y,title,body):
    p=Paragraph(body,styles['body']);_,ht=p.wrap(CW-28,600);height=ht+48
    box(M,y,CW,height);text(title,M+14,y-12,CW-28,'label',BLUE);text(body,M+14,y-36,CW-28);return y-height-22

# 1
c.setFillColor(INK);c.rect(0,0,W,H,fill=1,stroke=0)
text('CLINICAL PHOTOGRAPHY',M,H-65,style='label',color=HexColor('#9dbdff'))
text('From first frame<br/>to portfolio.',M,H-135,style='h',color=white)
text('A field guide for clearer images.<br/>A workbook for a repeatable process.',M,H-245,style='body',color=HexColor('#d3dff3'))
# Camera schematic, original vector illustration.
c.setStrokeColor(HexColor('#81aaff'));c.setLineWidth(2);c.roundRect(110,270,375,190,22,fill=0,stroke=1);c.roundRect(151,460,100,25,6,fill=0,stroke=1)
for r in [66,51,25]:c.circle(303,365,r,fill=0,stroke=1)
c.roundRect(404,401,42,20,4,fill=0,stroke=1)
text('06 MODULES  /  12 LESSONS  /  01 PORTFOLIO',M,215,style='label',color=white)
text('Work with a dental model or another non-patient object. Diagrams are conceptual training illustrations, not patient photographs or clinical evidence.',M,164,style='small',color=HexColor('#d3dff3'))
text('Demonstration edition - October 2026. No approved education credits. Clinical delivery requires academy faculty review.',M,103,style='small',color=HexColor('#9dbdff'));end()
# 2
y=page('Your finish line','Make the process repeatable.','By the end, keep six things you can use again.')
for i,(label,body) in enumerate([('01  A baseline','One unplanned model frame, kept for comparison.'),('02  A setup card','Camera, lens, lighting, geometry and settings that worked.'),('03  A complete sequence','Frontal, right, left, upper and lower model views.'),('04  An improvement pair','The original and repeat, with one deliberate change.'),('05  A traceable handoff','Original files, a view index and transformation notes.'),('06  A next-session plan','The one variable you will test next.')]):
    text(label,M,y,style='label',color=BLUE);y=text(body,M,y-21)-22
callout(y,'Use this book as you learn','Read the lesson, try its task, then record what changed. Your portfolio is self-reviewed; the platform does not grade photographs.');end()
# 3
y=page('Field guide 01','The setup card','Write down the arrangement that worked, rather than guessing tomorrow.')
for label in ['Model / training ID and purpose','Camera or phone, lens and capture format','Working distance / magnification and orientation','Lighting type, position and background','Exposure settings and flash-sync check from the equipment manual','White-balance method and reference frame','What I will keep fixed in the next session']:
    y=lines(y,2,23,label)-10
end()
# 4
y=page('Field guide 02','Sharp where it matters.','Aperture is one part of the focus-and-exposure decision.')
for x,r,label in [(M+105,38,'Larger opening'),(M+CW-105,13,'Smaller opening')]:
    c.setFillColor(INK);c.circle(x,y-65,52,fill=1,stroke=0);c.setFillColor(white);c.circle(x,y-65,r,fill=1,stroke=0)
    text(label,x-85,y-132,170,'label')
y-=172
y=text('With other inputs unchanged, a higher f-number describes a smaller opening: less light enters, and depth of field generally increases. That does not guarantee a sharp frame. Close-up distance, motion, focus placement and equipment limits still matter.',M,y)-24
y=callout(y,'A controlled comparison','Keep the model and camera in the same position. Make two frames with one setting changed. Compare the intended feature at the same viewing size; record which setting changed and what improved.')
y=lines(y,3,25,'What changed? What remained unresolved?')
text('Read more: Nikon, Understanding Maximum Aperture. Use your device manual for equipment-specific settings; there is no universal exposure prescription here.',M,y-8,style='small',color=MUTED);end()
# 5
y=page('Field guide 03','Geometry before comparison.','Two sharp images can still describe different camera-subject relationships.')
for idx,title in enumerate(['A / baseline position','B / repeat this position']):
    x=M+idx*(CW/2+8);w=CW/2-8;box(x,y,w,235)
    cx=x+w/2;c.setStrokeColor(BLUE);c.setLineWidth(2);c.roundRect(cx-35,y-65,70,35,5,fill=0,stroke=1)
    c.line(cx,y-70,cx,y-155);c.circle(cx,y-178,22,fill=0,stroke=1)
    c.setDash(4,4);c.line(cx-65,y-178,cx+65,y-178);c.setDash()
    text(title,x+12,y-205,w-24,'small')
y-=266
y=text('Match camera height, direction, distance and model orientation. A smaller crop after capture cannot prove that the original geometry was equivalent. Keep an honest note when conditions differ.',M,y)-22
y=lines(y,4,27,'My repeatable position markers')
text('Conceptual top-view diagram. Camera and model positions are illustrative, not clinical positioning instructions.',M,y-6,style='small',color=MUTED);end()
# 6
y=page('Field guide 04','A five-view model sequence','Count intended views, not just the number of files.')
for idx,label in enumerate(['01 / Frontal','02 / Right lateral','03 / Left lateral','04 / Upper occlusal','05 / Lower occlusal']):
    top=y-idx*83;box(M,top,CW,68);c.setStrokeColor(TEAL);c.setLineWidth(2)
    # U-shaped marker, deliberately schematic rather than anatomical.
    path=c.beginPath();path.moveTo(M+23,top-20);path.curveTo(M+16,top-57,M+66,top-57,M+59,top-20);c.drawPath(path)
    text(label,M+85,top-15,CW-110,'label');text('Capture -> check orientation -> index the file',M+85,top-36,CW-110,'small')
y-=438
text('Use the subject-side convention in your capture record. Mirror reflections and transformed copies need explicit orientation notes. If orientation is uncertain, resolve it from the capture record or repeat the model view.',M,y)
text('Training sequence only. Schematic markers are not examples of a clinically acceptable image.',M,97,style='small',color=MUTED);end()
# 7
y=page('Field guide 05','The 60-second quality gate','Ask these questions before ending the capture session.')
for title,body in [('Purpose','Does this frame show the area or relationship I intended?'),('Clarity','Is the intended feature sharp enough at a useful viewing size?'),('Geometry','Are position, distance and framing repeatable?'),('Orientation','Can another person tell which view and side this is?'),('Coverage','Do I have each intended view, with no duplicates hiding a gap?'),('Provenance','Can I connect this image to its original and capture notes?')]:
    box(M,y,28,28);text(title,M+42,y,style='label');y=text(body,M+42,y-22,CW-42)-23
callout(y,'Repeat, rather than invent','If a reflection, obstruction or blur hides information, fix the capture and repeat. Editing cannot recover information that was never captured.');end()
# 8
y=page('Field guide 06','A handoff you can trust','Preserve the source and make the transformation visible.')
for label,body in [('ORIGINALS / unchanged','TRAIN-042_frontal_01.original - source capture, retained intact'),('DERIVED / if needed','TRAIN-042_frontal_01_crop.jpg - permitted crop, documented'),('INDEX / the connecting record','View | orientation | source filename | change made | review note')]:
    y=callout(y,label,body)
y=text('Use fictional training identifiers here. Real patient material belongs in your organisation\'s approved clinical systems under its local governance and permissions. Do not upload patient photographs into this course or workbook.',M,y)-25
y=lines(y,4,26,'What should the next person be able to understand?');end()
# 9-14
for module in range(6):
    group=D['lessons'][module*2:module*2+2]
    y=page(f'Practice lab {module+1:02d}',D['modules'][module][5:],'Read the two lessons, then record your own observations below.')
    for idx,item in enumerate(group):
        y=text(f'{module*2+idx+1:02d} / '+escape(item['title']),M,y,style='label',color=BLUE)-12
        y=text(escape(item['exercise']),M,y)-17
        y=lines(y,3,23)-12
    y=callout(y,'One useful decision','Which change will you keep? What evidence supports it? If you changed several things at once, isolate one variable in your next attempt.')
    end()
# 15
y=page('Portfolio challenge','Show the process, not just the result.','Keep your work locally. This rubric supports self-review, not faculty certification.')
y=text('Your package: a setup card; five labeled model views; one baseline/repeat pair; a short view index; and a reflection naming one improvement and one limitation.',M,y)-24
for title,body in [('Repeatability','The setup and camera-subject relationship can be reproduced.'),('Coverage','All five intended model views are present and indexed.'),('Clarity','The intended features are visible, with no unresolved blur or obstruction.'),('Orientation','Side, view and any transformations are unambiguous.'),('Integrity','Originals remain intact and derived copies have a record.'),('Reflection','The chosen improvement is explained with a fair comparison.')]:
    y=text(title,M,y,style='label',color=BLUE)-4;y=text(body,M,y)-8;y=text('Circle one:  Needs another attempt  /  Developing  /  Consistent',M,y,style='small',color=MUTED)-19
end()
# 16
y=page('Your next session','Turn learning into a routine.','Finish the assessment, then choose a next step you can actually repeat.')
y=lines(y,3,24,'The one improvement I will test next')-12
y=lines(y,3,24,'The setup details I must keep fixed')-12
y=text('Further reading',M,y,style='label',color=BLUE)-12
for ref in D['references']:
    y=text(escape(ref['title']),M,y,style='small')-3
    # Clickable reference labels avoid long, broken printed URLs.
    c.linkURL(ref['url'],(M,y,W-M,y+18),relative=0,thickness=0)
    y-=10
y=text('References support background reading; the exercises and conceptual illustrations are original. GDC material is UK professional context, not a substitute for local policy. No clinical care, diagnosis, treatment plan or accreditation is provided by this demonstration.',M,y-15,style='small',color=MUTED)
end();c.save()
assert c.getPageNumber()-1==16
shutil.copyfile(OUT,ROOT/'assets/courses/photography-portfolio-workbook.pdf')
print(OUT)
